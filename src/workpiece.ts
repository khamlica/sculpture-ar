import {
  Box3,
  BoxGeometry,
  createSystem,
  DepthOccludable,
  DoubleSide,
  EdgesGeometry,
  Entity,
  EnvironmentRaycastTarget,
  Group,
  Hovered,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  OcclusionShadersMode,
  RayInteractable,
  Raycaster,
  RaycastSpace,
  RingGeometry,
  UIKit,
  UIKitMLAsset,
  Vector3,
} from '@iwsdk/core';

// ============ Réglages à adapter avant le TP ============

/** Dimensions de départ du bloc réel, en mètres : largeur, hauteur, profondeur. Réglables ensuite dans le panneau. */
const BLOCK_SIZE = new Vector3(0.07, 0.07, 0.07);
/** Marge entre la figurine et les parois du bloc, en mètres. */
const MARGIN = 0.005;
/** Taille des petits cubes du mode « matière à retirer », en mètres (0.005 = 5 mm). */
const VOXEL_SIZE = 0.005;
/** Vitesse de rotation au joystick, en radians par seconde. */
const ROTATION_SPEED = 0.8;
/** Vitesse de réglage de la hauteur au joystick, en mètres par seconde (0.02 = 2 cm/s). */
const HEIGHT_SPEED = 0.02;
/** Maquette tournante : agrandissement par rapport à la figurine dans le bloc, et vitesse de rotation automatique. */
const MAQUETTE_SCALE = 2;
const MAQUETTE_SPEED = 0.3;
/** Pas des boutons du panneau de réglages : taille du bloc (m) et opacité du mode transparent. */
const SIZE_STEP = 0.002;
const OPACITY_STEP = 0.1;
/** En dessous de cette valeur, le joystick est considéré au repos. */
const STICK_DEADZONE = 0.2;
/** Faux « cube réel » pour s'entraîner dans l'émulateur : affiché seulement sur le PC (localhost). */
const PRACTICE_CUBE = location.hostname === 'localhost';

// ========================================================

type DisplayMode = 'solid' | 'transparent' | 'wireframe' | 'removal' | 'reveal';
const DISPLAY_MODES: DisplayMode[] = ['solid', 'transparent', 'wireframe', 'removal', 'reveal'];

type Side = 'left' | 'right';
const SIDES: Side[] = ['right', 'left'];
/** Boutons équivalents sur chaque manette : A/X pour l'affichage, B/Y pour le verrouillage. */
const DISPLAY_BUTTON: Record<Side, string> = { right: 'a-button', left: 'x-button' };
const LOCK_BUTTON: Record<Side, string> = { right: 'b-button', left: 'y-button' };
const THUMBSTICK = 'xr-standard-thumbstick';
const SQUEEZE = 'xr-standard-squeeze';
/** Noms des modes sur le panneau (sans accents : la police du panneau n'en a pas). */
const MODE_LABELS: Record<DisplayMode, string> = {
  solid: 'plein',
  transparent: 'transparent',
  wireframe: 'fil de fer',
  removal: 'matiere a retirer',
  reveal: 'revelation (profondeur)',
};

/** Ce que renvoie this.input.xr.gamepads.right ou .left (une manette, ou une main). */
type Gamepad = NonNullable<WorkpieceSystem['input']['xr']['gamepads']['right']>;

/**
 * La pièce de travail : un bloc virtuel aux dimensions du bloc réel, avec la figurine dedans.
 * Phase 1 (déverrouillé) : on aligne le bloc virtuel sur le bloc réel.
 * Phase 2 (verrouillé)   : plus rien ne bouge, on sculpte en tournant autour.
 *
 * Commandes, sur l'une ou l'autre manette :
 *   gâchette maintenue      = glisser le bloc sur la surface visée
 *   joystick gauche/droite  = tourner le bloc
 *   joystick haut/bas       = monter / descendre le bloc (déverrouillé)
 *                             changer de couche (verrouillé, mode « matière à retirer »)
 *   A ou X = changer l'affichage : plein / transparent / fil de fer / matière à retirer / révélation
 *   B ou Y = verrouiller / déverrouiller
 *   poignée = afficher / cacher la maquette tournante (verrouillé)
 *
 * Support suivi (activable dans le panneau de réglages) : au verrouillage, la manette qui N'A PAS appuyé
 * sur B/Y (scotchée sur la planche) devient le traceur, et le bloc suit ses mouvements.
 *             joystick gauche/droite la fait tourner à la main, sinon elle tourne seule
 */
export class WorkpieceSystem extends createSystem({
  // Panneaux actuellement visés par un rayon : on ne déplace pas le bloc quand on clique sur un bouton
  hoveredPanels: { required: [RayInteractable, Hovered] },
}) {
  /** Dimensions actuelles du bloc (modifiables depuis le panneau de réglages). */
  private blockSize = BLOCK_SIZE.clone();
  private blockEdges: LineSegments | undefined;
  private workpiece: Object3D | undefined;
  private model: Object3D | undefined;
  private blockFaces: Mesh | undefined;

  /** Un viseur par manette : on utilise celui de la manette dont on appuie sur la gâchette. */
  private reticles: Partial<Record<Side, Entity>> = {};
  private reticleMaterial = new MeshBasicMaterial({ color: 0x00ff88 });

  private locked = false;
  private modeIndex = 0;
  private heightOffset = 0;
  private originalMaterials = new Map<Mesh, Material | Material[]>();
  private transparentMaterial = new MeshStandardMaterial({
    color: 0xffd34d,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
  });
  private wireframeMaterial = new MeshBasicMaterial({ color: 0xffd34d, wireframe: true });

  /** Mode « matière à retirer » : une couche horizontale de petits cubes rouges par étage. */
  private removalGroup: Group | undefined;
  private removalLayers: InstancedMesh[] = [];
  private currentLayer = 0;

  /** Maquette : une copie agrandie de la figurine, posée à côté du bloc, qu'on peut faire tourner librement. */
  private maquette: Group | undefined;
  private showMaquette = false;

  /**
   * Mode « révélation » (expérimental) : le canard est gris, et une copie en couleur posée exactement dessus
   * est masquée par les surfaces réelles mesurées par le capteur de profondeur du casque.
   * Là où il reste de la pâte devant le canard : gris. Là où la pâte a été enlevée : couleur.
   */
  private revealCopy: Object3D | undefined;
  private greyMaterial = new MeshStandardMaterial({ color: 0x8a8a8a });

  /** Support suivi : une manette scotchée sur la planche sert de traceur pendant la phase verrouillée. */
  private trackingEnabled = false;
  private trackerSide: Side | undefined;
  /** Position du bloc par rapport à la manette traceur, mémorisée au verrouillage. */
  private trackerOffset = new Matrix4();
  private trackerLost = false;

  /** Ligne d'état du panneau d'aide. */
  private statusText: UIKit.Text | undefined;

  private tmp = new Vector3();

  // ---------- Démarrage ----------

  init(): void {
    this.reticles.right = this.createReticle(RaycastSpace.Right);
    this.reticles.left = this.createReticle(RaycastSpace.Left);
    if (PRACTICE_CUBE) this.createPracticeCube();
  }

  // ---------- À chaque image : le chef d'orchestre ----------

  update(delta: number): void {
    // 1. Tant que la pièce de travail n'est pas prête, on la prépare
    if (!this.workpiece) {
      this.setupWorkpiece();
      return;
    }
    const pads = this.getPads();
    if (pads.length === 0) return;

    // 2. Verrouillage et affichage : toujours disponibles
    this.handleLock(pads);
    this.handleDisplayMode(pads);

    // 3. Verrouillé : rien ne bouge. Seul le choix de la couche reste possible.
    if (this.locked) {
      this.followTracker();
      this.handleLayer(pads);
      this.handleMaquette(pads, delta);
      return;
    }

    // 4. Déverrouillé : on aligne
    this.handleMove(pads);
    this.handleRotate(pads, delta);
    this.handleHeight(pads, delta);
  }

  /** Les manettes (ou mains) présentes, avec leur côté. */
  private getPads(): { side: Side; pad: Gamepad }[] {
    const result: { side: Side; pad: Gamepad }[] = [];
    for (const side of SIDES) {
      const pad = this.input.xr.gamepads[side];
      if (pad) result.push({ side, pad });
    }
    return result;
  }

  // ---------- Préparation de la pièce de travail ----------

  /** Une seule fois, dès que le modèle 3D est chargé : bloc virtuel + figurine ajustée dedans. */
  private setupWorkpiece(): void {
    const workpiece = this.world.getSceneObject('workpiece');
    const model = this.world.getSceneObject('duck');
    if (!workpiece || !model) return;
    if (!this.fitModelInBlock(workpiece, model)) return; // modèle pas encore chargé : on réessaiera

    this.blockFaces = this.createBlock(workpiece);
    this.rememberMaterials(model);
    this.workpiece = workpiece;
    this.model = model;
    this.maquette = this.createMaquette(workpiece, model);
    this.statusText =
      this.world.getSceneObject<UIKitMLAsset>('welcome-panel')?.getElementById<UIKit.Text>('status') ??
      undefined;
    this.bindSettings();
    this.refreshVisibility();
  }

  /** Met la figurine à l'échelle pour qu'elle tienne dans le bloc, centrée et posée au fond. */
  private fitModelInBlock(workpiece: Object3D, model: Object3D): boolean {
    model.position.set(0, 0, 0);
    model.rotation.set(0, 0, 0);
    model.scale.setScalar(1);

    // On mesure la figurine dans le repère de la pièce : on neutralise un instant sa position et sa rotation
    const savedPosition = workpiece.position.clone();
    const savedQuaternion = workpiece.quaternion.clone();
    workpiece.position.set(0, 0, 0);
    workpiece.quaternion.identity();
    workpiece.updateWorldMatrix(true, true);
    const bounds = new Box3().setFromObject(model);
    const origin = workpiece.getWorldPosition(new Vector3());
    workpiece.position.copy(savedPosition);
    workpiece.quaternion.copy(savedQuaternion);
    workpiece.updateWorldMatrix(true, true);
    if (bounds.isEmpty()) return false;

    // Boîte englobante de la figurine, exprimée par rapport à l'origine de la pièce de travail
    bounds.min.sub(origin);
    bounds.max.sub(origin);
    const size = bounds.getSize(new Vector3());
    const center = bounds.getCenter(new Vector3());

    // Le plus grand facteur qui laisse la marge sur les côtés et en haut
    const scale = Math.min(
      (this.blockSize.x - 2 * MARGIN) / size.x,
      (this.blockSize.y - MARGIN) / size.y,
      (this.blockSize.z - 2 * MARGIN) / size.z,
    );
    model.scale.setScalar(scale);
    model.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
    return true;
  }

  /** Le bloc virtuel : faces translucides + arêtes. L'origine est au centre de la face du dessous. */
  private createBlock(workpiece: Object3D): Mesh {
    const geometry = new BoxGeometry(this.blockSize.x, this.blockSize.y, this.blockSize.z);
    const faces = new Mesh(
      geometry,
      new MeshBasicMaterial({ color: 0xd9a066, transparent: true, opacity: 0.25, depthWrite: false }),
    );
    const edges = new LineSegments(
      new EdgesGeometry(geometry),
      new LineBasicMaterial({ color: 0xd9a066 }),
    );
    faces.position.y = this.blockSize.y / 2;
    edges.position.y = this.blockSize.y / 2;
    workpiece.add(faces, edges);
    this.blockEdges = edges;
    return faces;
  }

  // ---------- Commandes ----------

  /** B (droite) ou Y (gauche) : verrouille ou déverrouille. */
  private handleLock(pads: { side: Side; pad: Gamepad }[]): void {
    const presser = pads.find(({ side, pad }) => pad.getButtonDown(LOCK_BUTTON[side]));
    if (!presser) return;
    this.locked = !this.locked;
    this.trackerSide = undefined;
    if (!this.locked) this.levelWorkpiece(); // déverrouillé : bloc remis droit, pour que les outils d'alignement marchent
    if (this.locked && this.trackingEnabled) this.attachTracker(presser.side === 'right' ? 'left' : 'right');
    this.refreshVisibility();
  }

  /** A (droite) ou X (gauche) : passe au mode d'affichage suivant. */
  private handleDisplayMode(pads: { side: Side; pad: Gamepad }[]): void {
    if (!pads.some(({ side, pad }) => pad.getButtonDown(DISPLAY_BUTTON[side]))) return;
    this.modeIndex = (this.modeIndex + 1) % DISPLAY_MODES.length;
    this.applyDisplayMode(DISPLAY_MODES[this.modeIndex]);
  }

  /** Gâchette maintenue en visant une surface : le bloc glisse jusqu'au viseur de cette manette. */
  private handleMove(pads: { side: Side; pad: Gamepad }[]): void {
    if (!this.workpiece) return;
    if (this.queries.hoveredPanels.entities.size > 0) return; // on vise un panneau : c'est un clic de bouton
    for (const { side, pad } of pads) {
      const reticle = this.reticles[side];
      if (!pad.getSelecting() || !reticle?.object3D) continue;
      if (!reticle.getValue(EnvironmentRaycastTarget, 'xrHitTestResult')) continue;

      reticle.object3D.getWorldPosition(this.tmp);
      this.workpiece.parent?.worldToLocal(this.tmp);
      this.workpiece.position.copy(this.tmp);
      this.workpiece.position.y += this.heightOffset; // on garde la correction de hauteur déjà réglée
      return;
    }
  }

  /** Joystick gauche/droite : le bloc tourne sur lui-même (axe vertical). Plus on pousse, plus ça tourne vite. */
  private handleRotate(pads: { side: Side; pad: Gamepad }[], delta: number): void {
    const x = this.stickValue(pads, 'x');
    if (x === 0 || !this.workpiece) return;
    this.workpiece.rotation.y -= x * ROTATION_SPEED * delta;
  }

  /** Joystick haut/bas : monte ou descend le bloc, pour corriger la hauteur mesurée par le hit-test. */
  private handleHeight(pads: { side: Side; pad: Gamepad }[], delta: number): void {
    const y = this.stickValue(pads, 'y');
    if (y === 0 || !this.workpiece) return;
    // Sur une manette, pousser le joystick vers le haut donne une valeur négative
    const change = -y * HEIGHT_SPEED * delta;
    this.heightOffset += change;
    this.workpiece.position.y += change;
  }

  /** Verrouillé, mode « matière à retirer » : joystick haut/bas = couche du dessus / du dessous. */
  private handleLayer(pads: { side: Side; pad: Gamepad }[]): void {
    if (DISPLAY_MODES[this.modeIndex] !== 'removal' || this.removalLayers.length === 0) return;
    let step = 0;
    for (const { pad } of pads) {
      if (pad.getAxesEnteringUp(THUMBSTICK)) step += 1;
      if (pad.getAxesEnteringDown(THUMBSTICK)) step -= 1;
    }
    if (step === 0) return;
    this.currentLayer = Math.min(this.removalLayers.length - 1, Math.max(0, this.currentLayer + step));
    this.refreshVisibility();
  }

  /** Verrouillé : la poignée affiche ou cache la maquette ; le joystick la fait tourner, sinon elle tourne seule. */
  private handleMaquette(pads: { side: Side; pad: Gamepad }[], delta: number): void {
    if (!this.maquette) return;
    if (pads.some(({ pad }) => pad.getButtonDown(SQUEEZE))) {
      this.showMaquette = !this.showMaquette;
      this.refreshVisibility();
    }
    if (!this.showMaquette) return;
    const x = this.stickValue(pads, 'x');
    this.maquette.rotation.y += (x !== 0 ? -x * ROTATION_SPEED * 2 : MAQUETTE_SPEED) * delta;
  }

  /** Valeur d'un axe du joystick (somme des deux manettes), 0 si au repos. */
  private stickValue(pads: { side: Side; pad: Gamepad }[], axis: 'x' | 'y'): number {
    let value = 0;
    for (const { pad } of pads) {
      const v = pad.getAxesValues(THUMBSTICK)?.[axis] ?? 0;
      if (Math.abs(v) >= STICK_DEADZONE) value += v;
    }
    return value;
  }

  // ---------- Ce qu'on voit ----------

  /** Visibilité de chaque élément selon la phase (verrouillé ou non) et le mode d'affichage. */
  private refreshVisibility(): void {
    const removal = DISPLAY_MODES[this.modeIndex] === 'removal';
    if (this.blockFaces) this.blockFaces.visible = !this.locked; // faces : seulement pendant l'alignement
    if (this.model) this.model.visible = this.locked; // figurine : seulement une fois verrouillé
    this.reticleMaterial.visible = !this.locked; // viseurs : seulement pendant l'alignement
    if (this.removalGroup) this.removalGroup.visible = this.locked && removal;
    this.removalLayers.forEach((layer, index) => (layer.visible = index === this.currentLayer));
    if (this.maquette) this.maquette.visible = this.locked && this.showMaquette;
    if (this.revealCopy) this.revealCopy.visible = this.locked && DISPLAY_MODES[this.modeIndex] === 'reveal';
    this.updateStatus();
  }

  /** Ligne d'état du panneau : phase, mode d'affichage, couche. */
  private updateStatus(): void {
    const mode = DISPLAY_MODES[this.modeIndex];
    let text = `${this.locked ? 'VERROUILLE' : 'ALIGNEMENT'} | ${MODE_LABELS[mode]}`;
    if (mode === 'removal' && this.removalLayers.length > 0) {
      text += ` | couche ${this.currentLayer + 1}/${this.removalLayers.length}`;
    }
    if (this.locked && this.trackingEnabled) {
      if (!this.trackerSide) text += ' | suivi : manette introuvable';
      else text += ` | suivi manette ${this.trackerSide === 'left' ? 'gauche' : 'droite'}${this.trackerLost ? ' (perdue)' : ''}`;
    }
    this.statusText?.setProperties({ text });
  }

  private rememberMaterials(model: Object3D): void {
    model.traverse((object) => {
      if (object instanceof Mesh) this.originalMaterials.set(object, object.material);
    });
  }

  private applyDisplayMode(mode: DisplayMode): void {
    if (mode === 'removal' && !this.removalGroup) this.buildRemovalLayers();
    if (mode === 'reveal' && !this.revealCopy) this.createRevealCopy();
    for (const [mesh, original] of this.originalMaterials) {
      if (mode === 'solid') mesh.material = original;
      else if (mode === 'transparent') mesh.material = this.transparentMaterial;
      else if (mode === 'reveal') mesh.material = this.greyMaterial;
      else mesh.material = this.wireframeMaterial; // fil de fer, et en contexte du mode « matière à retirer »
    }
    this.refreshVisibility();
  }

  // ---------- Mode « matière à retirer » ----------

  /**
   * Découpe le bloc en petits cubes et garde ceux qui sont HORS de la figurine : la matière à enlever.
   * Calculé une seule fois (la première fois qu'on choisit ce mode), puis rangé couche par couche.
   */
  private buildRemovalLayers(): void {
    if (!this.workpiece || !this.model) return;
    const workpiece = this.workpiece;
    const model = this.model;

    const nx = Math.max(1, Math.round(this.blockSize.x / VOXEL_SIZE));
    const ny = Math.max(1, Math.round(this.blockSize.y / VOXEL_SIZE));
    const nz = Math.max(1, Math.round(this.blockSize.z / VOXEL_SIZE));
    const cell = new Vector3(this.blockSize.x / nx, this.blockSize.y / ny, this.blockSize.z / nz);

    // Pour compter les traversées de surface, le rayon doit « voir » les deux faces des triangles
    const meshes = [...this.originalMaterials.keys()];
    const currentMaterials = meshes.map((mesh) => mesh.material);
    const probe = new MeshBasicMaterial({ side: DoubleSide });
    meshes.forEach((mesh) => (mesh.material = probe));
    workpiece.updateWorldMatrix(true, true);

    // Direction du rayon, exprimée dans le repère de la pièce (un seul rayon suffit :
    // testé hors casque, trois directions donnaient exactement le même verdict sur le canard)
    const direction = new Vector3(1, 0, 0).transformDirection(workpiece.matrixWorld);
    const raycaster = new Raycaster();
    const local = new Vector3();
    const world = new Vector3();

    /** Un point est dans la figurine si un rayon qui en part traverse sa surface un nombre impair de fois. */
    const isInside = (point: Vector3): boolean => {
      raycaster.set(point, direction);
      return raycaster.intersectObject(model, true).length % 2 === 1;
    };

    const group = new Group();
    const voxelGeometry = new BoxGeometry(cell.x * 0.85, cell.y * 0.85, cell.z * 0.85);
    const voxelMaterial = new MeshBasicMaterial({
      color: 0xff3b30,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    const matrix = new Matrix4();

    for (let j = 0; j < ny; j++) {
      const positions: Vector3[] = [];
      for (let i = 0; i < nx; i++) {
        for (let k = 0; k < nz; k++) {
          local.set(
            -this.blockSize.x / 2 + (i + 0.5) * cell.x,
            (j + 0.5) * cell.y,
            -this.blockSize.z / 2 + (k + 0.5) * cell.z,
          );
          world.copy(local);
          workpiece.localToWorld(world);
          if (!isInside(world)) positions.push(local.clone());
        }
      }
      const layer = new InstancedMesh(voxelGeometry, voxelMaterial, Math.max(1, positions.length));
      layer.count = positions.length;
      positions.forEach((p, index) => layer.setMatrixAt(index, matrix.makeTranslation(p.x, p.y, p.z)));
      layer.instanceMatrix.needsUpdate = true;
      group.add(layer);
      this.removalLayers.push(layer);
    }

    // On remet les matériaux d'affichage et on range les couches dans la pièce de travail
    meshes.forEach((mesh, index) => (mesh.material = currentMaterials[index]));
    workpiece.add(group);
    this.removalGroup = group;
    this.currentLayer = ny - 1; // on commence par la couche du dessus
  }

  // ---------- Mode « révélation » (profondeur) ----------

  /** Copie en couleur du canard, posée exactement sur lui, masquée par le réel grâce à la profondeur du casque. */
  private createRevealCopy(): void {
    const parent = this.world.getSceneEntity('workpiece');
    if (!this.model || !parent) return;

    // Copie avec les vraies couleurs
    const meshes = [...this.originalMaterials.keys()];
    const current = meshes.map((mesh) => mesh.material);
    this.originalMaterials.forEach((original, mesh) => (mesh.material = original));
    const copy = this.model.clone(true);
    meshes.forEach((mesh, i) => (mesh.material = current[i]));
    copy.visible = true;

    // Matériaux clonés (le système de profondeur modifie leurs shaders) et légèrement « avancés »
    // pour passer devant le canard gris, qui occupe exactement la même place
    const prepare = (material: Material): Material => {
      const clone = material.clone();
      clone.polygonOffset = true;
      clone.polygonOffsetFactor = -1;
      clone.polygonOffsetUnits = -4;
      return clone;
    };
    copy.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      object.material = Array.isArray(object.material) ? object.material.map(prepare) : prepare(object.material);
      object.renderOrder = 1;
    });

    // En faire une entité, enfant de la pièce de travail, masquée par les surfaces réelles
    const entity = this.world.createTransformEntity(copy, { parent });
    entity.addComponent(DepthOccludable, { mode: OcclusionShadersMode.HardOcclusion });
    this.revealCopy = copy;
    this.syncRevealCopy();
  }

  /** Garde la copie exactement sur le canard (après un changement de taille du bloc). */
  private syncRevealCopy(): void {
    if (!this.revealCopy || !this.model) return;
    this.revealCopy.position.copy(this.model.position);
    this.revealCopy.quaternion.copy(this.model.quaternion);
    this.revealCopy.scale.copy(this.model.scale);
  }

  // ---------- Support suivi par une manette ----------

  /** Une manette (et non une main suivie) : elle a un joystick. */
  private isController(pad: Gamepad | undefined): pad is Gamepad {
    return !!pad && pad.getAxesValues(THUMBSTICK) !== undefined;
  }

  /** La pose (position + orientation) de la manette dans la pièce. */
  private trackerMatrix(side: Side): Matrix4 | undefined {
    const grip = this.world.playerSpaceEntities.gripSpaces[side].object3D;
    if (!grip) return undefined;
    grip.updateWorldMatrix(true, false);
    return grip.matrixWorld;
  }

  /** Au verrouillage : mémorise où est le bloc par rapport à la manette scotchée. */
  private attachTracker(side: Side): void {
    if (!this.workpiece || !this.isController(this.input.xr.gamepads[side])) return;
    const tracker = this.trackerMatrix(side);
    if (!tracker) return;
    this.workpiece.updateWorldMatrix(true, false);
    this.trackerOffset.copy(tracker).invert().multiply(this.workpiece.matrixWorld);
    this.trackerSide = side;
    this.trackerLost = false;
  }

  /** Verrouillé avec suivi : le bloc reprend chaque image sa place par rapport à la manette. */
  private followTracker(): void {
    if (!this.trackerSide || !this.workpiece) return;
    const pad = this.input.xr.gamepads[this.trackerSide];
    const tracker = this.isController(pad) ? this.trackerMatrix(this.trackerSide) : undefined;

    // Manette perdue ou remplacée par la main : on fige le bloc plutôt que de suivre la main
    const lost = !tracker;
    if (lost !== this.trackerLost) {
      this.trackerLost = lost;
      this.updateStatus();
    }
    if (!tracker) return;

    const world = new Matrix4().multiplyMatrices(tracker, this.trackerOffset);
    const parent = this.workpiece.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      world.premultiply(new Matrix4().copy(parent.matrixWorld).invert());
    }
    world.decompose(this.workpiece.position, this.workpiece.quaternion, this.tmp);
    // Le socle est posé sur une table : on ne garde que la rotation autour de la verticale,
    // pour ne pas pencher le bloc à cause des petites inclinaisons mesurées sur la manette
    this.levelWorkpiece();
  }

  /** Remet le bloc droit : on ne garde que sa rotation autour de l'axe vertical. */
  private levelWorkpiece(): void {
    if (!this.workpiece) return;
    // Axe « largeur » du bloc après rotation, projeté à l'horizontale → angle autour de la verticale
    const xAxis = new Vector3(1, 0, 0).applyQuaternion(this.workpiece.quaternion);
    const yaw = Math.atan2(-xAxis.z, xAxis.x);
    this.workpiece.rotation.set(0, yaw, 0);
  }

  // ---------- Panneau de réglages ----------

  /** Relie les boutons du panneau de réglages aux actions. */
  private bindSettings(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('settings-panel');
    if (!panel) return;
    const bind = (id: string, action: () => void) => {
      panel.getElementById(id)?.addEventListener('click', action);
    };
    bind('w-minus', () => this.changeSize('x', -SIZE_STEP));
    bind('w-plus', () => this.changeSize('x', SIZE_STEP));
    bind('h-minus', () => this.changeSize('y', -SIZE_STEP));
    bind('h-plus', () => this.changeSize('y', SIZE_STEP));
    bind('d-minus', () => this.changeSize('z', -SIZE_STEP));
    bind('d-plus', () => this.changeSize('z', SIZE_STEP));
    bind('o-minus', () => this.changeOpacity(-OPACITY_STEP));
    bind('o-plus', () => this.changeOpacity(OPACITY_STEP));
    bind('t-toggle', () => {
      this.trackingEnabled = !this.trackingEnabled;
      this.updateSettingsLabels();
      this.updateStatus();
    });
    this.updateSettingsLabels();
  }

  /** Change une dimension du bloc (seulement déverrouillé), puis reconstruit bloc, figurine, maquette et couches. */
  private changeSize(axis: 'x' | 'y' | 'z', step: number): void {
    if (this.locked || !this.workpiece || !this.model) return;
    this.blockSize[axis] = Math.min(0.5, Math.max(0.02, this.blockSize[axis] + step));

    const workpiece = this.workpiece;
    if (this.blockFaces) workpiece.remove(this.blockFaces);
    if (this.blockEdges) workpiece.remove(this.blockEdges);
    if (this.maquette) workpiece.remove(this.maquette);
    if (this.removalGroup) workpiece.remove(this.removalGroup);
    this.removalGroup = undefined;
    this.removalLayers = [];

    this.fitModelInBlock(workpiece, this.model);
    this.syncRevealCopy();
    this.blockFaces = this.createBlock(workpiece);
    this.maquette = this.createMaquette(workpiece, this.model);
    if (DISPLAY_MODES[this.modeIndex] === 'removal') this.buildRemovalLayers();
    this.updateSettingsLabels();
    this.refreshVisibility();
  }

  /** Change l'opacité du canard en mode transparent. */
  private changeOpacity(step: number): void {
    this.transparentMaterial.opacity = Math.min(1, Math.max(0.1, this.transparentMaterial.opacity + step));
    this.updateSettingsLabels();
  }

  /** Affiche les valeurs actuelles dans le panneau de réglages. */
  private updateSettingsLabels(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('settings-panel');
    const set = (id: string, text: string) => panel?.getElementById<UIKit.Text>(id)?.setProperties({ text });
    const cm = (meters: number) => `${(meters * 100).toFixed(1)} cm`;
    set('w-value', cm(this.blockSize.x));
    set('h-value', cm(this.blockSize.y));
    set('d-value', cm(this.blockSize.z));
    set('o-value', `${Math.round(this.transparentMaterial.opacity * 100)} %`);
    set('t-value', this.trackingEnabled ? 'oui' : 'non');
  }

  // ---------- Objets d'aide ----------

  /** Copie agrandie de la figurine (avec ses vraies couleurs), posée sur la table à droite du bloc. */
  private createMaquette(workpiece: Object3D, model: Object3D): Group {
    const pivot = new Group();
    // Créée maintenant : elle garde les matériaux d'origine. Sa position (déjà centrée
    // horizontalement par fitModelInBlock) la fait tourner sur place autour du pivot.
    const current = [...this.originalMaterials].map(([mesh]) => mesh.material);
    this.originalMaterials.forEach((original, mesh) => (mesh.material = original));
    const copy = model.clone(true);
    [...this.originalMaterials.keys()].forEach((mesh, i) => (mesh.material = current[i]));
    copy.visible = true;
    pivot.add(copy);
    pivot.scale.setScalar(MAQUETTE_SCALE);
    pivot.position.set(this.blockSize.x / 2 + this.blockSize.x * MAQUETTE_SCALE * 0.5 + 0.04, 0, 0);
    workpiece.add(pivot);
    return pivot;
  }

  /** Un viseur : anneau vert couché à plat, qui suit les surfaces réelles visées par une manette. */
  private createReticle(space: RaycastSpace): Entity {
    const ring = new Mesh(new RingGeometry(0.015, 0.02, 32).rotateX(-Math.PI / 2), this.reticleMaterial);
    const reticle = this.world.createTransformEntity(ring);
    reticle.addComponent(EnvironmentRaycastTarget, { space, maxDistance: 5 });
    return reticle;
  }

  /** Émulateur seulement : un faux cube « réel » posé au sol, légèrement tourné, pour s'entraîner à l'alignement. */
  private createPracticeCube(): void {
    const cube = new Mesh(
      new BoxGeometry(BLOCK_SIZE.x, BLOCK_SIZE.y, BLOCK_SIZE.z),
      // depthWrite: false + dessiné en premier = il se comporte comme le passthrough :
      // il ne masque jamais les objets virtuels, même ceux qui sont « dedans »
      new MeshStandardMaterial({ color: 0xc8b08a, depthWrite: false }),
    );
    cube.renderOrder = -1;
    cube.position.set(0.25, BLOCK_SIZE.y / 2, -0.9);
    cube.rotation.y = 0.4;
    this.world.createTransformEntity(cube);
  }
}
