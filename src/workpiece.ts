import {
  Box3,
  BoxGeometry,
  createSystem,
  EdgesGeometry,
  Entity,
  EnvironmentRaycastTarget,
  LineBasicMaterial,
  LineSegments,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  RaycastSpace,
  RingGeometry,
  Vector3,
} from '@iwsdk/core';

// ============ Réglages à adapter avant le TP ============

/** Dimensions du bloc réel (cube en carton), en mètres : largeur, hauteur, profondeur. À MESURER. */
const BLOCK_SIZE = new Vector3(0.07, 0.07, 0.07);
/** Marge entre la figurine et les parois du bloc, en mètres. */
const MARGIN = 0.005;
/** Vitesse de rotation au joystick, en radians par seconde. */
const ROTATION_SPEED = 0.8;
/** Vitesse de réglage de la hauteur au joystick, en mètres par seconde (0.02 = 2 cm/s). */
const HEIGHT_SPEED = 0.02;
/** En dessous de cette valeur, le joystick est considéré au repos. */
const STICK_DEADZONE = 0.2;
/** Faux « cube réel » pour s'entraîner dans l'émulateur : affiché seulement sur le PC (localhost). */
const PRACTICE_CUBE = location.hostname === 'localhost';

// ========================================================

type DisplayMode = 'solid' | 'transparent' | 'wireframe';
const DISPLAY_MODES: DisplayMode[] = ['solid', 'transparent', 'wireframe'];

/** Ce que renvoie this.input.xr.gamepads.right (manette droite). */
type Gamepad = NonNullable<WorkpieceSystem['input']['xr']['gamepads']['right']>;

/**
 * La pièce de travail : un bloc virtuel aux dimensions du bloc réel, avec la figurine dedans.
 * Phase 1 (déverrouillé) : on aligne le bloc virtuel sur le bloc réel.
 * Phase 2 (verrouillé)   : plus rien ne bouge, on sculpte en tournant autour.
 *
 * Manette droite :
 *   gâchette maintenue = glisser le bloc sur la surface visée
 *   joystick gauche/droite = tourner le bloc
 *   joystick haut/bas = monter / descendre le bloc (corrige l'erreur de hauteur du hit-test)
 *   A = changer l'affichage de la figurine (plein / transparent / fil de fer)
 *   B = verrouiller / déverrouiller
 */
export class WorkpieceSystem extends createSystem({}) {
  private workpiece: Object3D | undefined;
  private model: Object3D | undefined;
  private blockFaces: Mesh | undefined;
  private reticle: Entity | undefined;
  private reticleMaterial = new MeshBasicMaterial({ color: 0x00ff88 });

  private locked = false;
  /** Correction de hauteur réglée au joystick, ajoutée à la hauteur donnée par le hit-test. */
  private heightOffset = 0;
  private modeIndex = 0;
  private originalMaterials = new Map<Mesh, Material | Material[]>();
  private transparentMaterial = new MeshStandardMaterial({
    color: 0xffd34d,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
  });
  private wireframeMaterial = new MeshBasicMaterial({ color: 0xffd34d, wireframe: true });
  private tmp = new Vector3();

  // ---------- Démarrage ----------

  init(): void {
    this.createReticle();
    if (PRACTICE_CUBE) this.createPracticeCube();
  }

  // ---------- À chaque image : le chef d'orchestre ----------

  update(delta: number): void {
    // 1. Tant que la pièce de travail n'est pas prête, on la prépare
    if (!this.workpiece) {
      this.setupWorkpiece();
      return;
    }
    const pad = this.input.xr.gamepads.right;
    if (!pad) return;

    // 2. Verrouillage et affichage : toujours disponibles
    this.handleLock(pad);
    this.handleDisplayMode(pad);

    // 3. Verrouillé : plus rien ne bouge
    if (this.locked) return;

    // 4. Déverrouillé : on aligne
    this.handleMove(pad);
    this.handleRotate(pad, delta);
    this.handleHeight(pad, delta);
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
    this.applyLockAppearance();
  }

  /** Met la figurine à l'échelle pour qu'elle tienne dans le bloc, centrée et posée au fond. */
  private fitModelInBlock(workpiece: Object3D, model: Object3D): boolean {
    model.position.set(0, 0, 0);
    model.rotation.set(0, 0, 0);
    model.scale.setScalar(1);
    workpiece.updateWorldMatrix(true, true);

    const bounds = new Box3().setFromObject(model);
    if (bounds.isEmpty()) return false;

    // Boîte englobante de la figurine, exprimée par rapport à l'origine de la pièce de travail
    const origin = workpiece.getWorldPosition(new Vector3());
    bounds.min.sub(origin);
    bounds.max.sub(origin);
    const size = bounds.getSize(new Vector3());
    const center = bounds.getCenter(new Vector3());

    // Le plus grand facteur qui laisse la marge sur les côtés et en haut
    const scale = Math.min(
      (BLOCK_SIZE.x - 2 * MARGIN) / size.x,
      (BLOCK_SIZE.y - MARGIN) / size.y,
      (BLOCK_SIZE.z - 2 * MARGIN) / size.z,
    );
    model.scale.setScalar(scale);
    model.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
    return true;
  }

  /** Le bloc virtuel : faces translucides + arêtes. L'origine est au centre de la face du dessous. */
  private createBlock(workpiece: Object3D): Mesh {
    const geometry = new BoxGeometry(BLOCK_SIZE.x, BLOCK_SIZE.y, BLOCK_SIZE.z);
    const faces = new Mesh(
      geometry,
      new MeshBasicMaterial({ color: 0xd9a066, transparent: true, opacity: 0.25, depthWrite: false }),
    );
    const edges = new LineSegments(
      new EdgesGeometry(geometry),
      new LineBasicMaterial({ color: 0xd9a066 }),
    );
    faces.position.y = BLOCK_SIZE.y / 2;
    edges.position.y = BLOCK_SIZE.y / 2;
    workpiece.add(faces, edges);
    return faces;
  }

  // ---------- Commandes ----------

  /** Bouton B : verrouille ou déverrouille. */
  private handleLock(pad: Gamepad): void {
    if (!pad.getButtonDown('b-button')) return;
    this.locked = !this.locked;
    this.applyLockAppearance();
  }

  /** Ce qu'on voit selon la phase. */
  private applyLockAppearance(): void {
    if (this.blockFaces) this.blockFaces.visible = !this.locked; // faces : seulement pendant l'alignement
    if (this.model) this.model.visible = this.locked; // figurine : seulement une fois verrouillé
    this.reticleMaterial.visible = !this.locked; // viseur : seulement pendant l'alignement
  }

  /** Gâchette maintenue en visant une surface : le bloc glisse jusqu'au viseur. */
  private handleMove(pad: Gamepad): void {
    if (!pad.getSelecting() || !this.reticle?.object3D || !this.workpiece) return;
    const hit = this.reticle.getValue(EnvironmentRaycastTarget, 'xrHitTestResult');
    if (!hit) return;
    this.reticle.object3D.getWorldPosition(this.tmp);
    this.workpiece.parent?.worldToLocal(this.tmp);
    this.workpiece.position.copy(this.tmp);
    this.workpiece.position.y += this.heightOffset; // on garde la correction de hauteur déjà réglée
  }

  /** Joystick gauche/droite : le bloc tourne sur lui-même (axe vertical). Plus on pousse, plus ça tourne vite. */
  private handleRotate(pad: Gamepad, delta: number): void {
    const stick = pad.getAxesValues('xr-standard-thumbstick');
    if (!stick || Math.abs(stick.x) < STICK_DEADZONE || !this.workpiece) return;
    this.workpiece.rotation.y -= stick.x * ROTATION_SPEED * delta;
  }

  /** Joystick haut/bas : monte ou descend le bloc, pour corriger la hauteur mesurée par le hit-test. */
  private handleHeight(pad: Gamepad, delta: number): void {
    const stick = pad.getAxesValues('xr-standard-thumbstick');
    if (!stick || Math.abs(stick.y) < STICK_DEADZONE || !this.workpiece) return;
    // Sur une manette, pousser le joystick vers le haut donne une valeur négative
    const change = -stick.y * HEIGHT_SPEED * delta;
    this.heightOffset += change;
    this.workpiece.position.y += change;
  }

  /** Bouton A : passe au mode d'affichage suivant. */
  private handleDisplayMode(pad: Gamepad): void {
    if (!pad.getButtonDown('a-button')) return;
    this.modeIndex = (this.modeIndex + 1) % DISPLAY_MODES.length;
    this.applyDisplayMode(DISPLAY_MODES[this.modeIndex]);
  }

  // ---------- Affichage de la figurine ----------

  private rememberMaterials(model: Object3D): void {
    model.traverse((object) => {
      if (object instanceof Mesh) this.originalMaterials.set(object, object.material);
    });
  }

  private applyDisplayMode(mode: DisplayMode): void {
    for (const [mesh, original] of this.originalMaterials) {
      if (mode === 'solid') mesh.material = original;
      else if (mode === 'transparent') mesh.material = this.transparentMaterial;
      else mesh.material = this.wireframeMaterial;
    }
  }

  // ---------- Objets d'aide ----------

  /** Le viseur : un anneau vert couché à plat, qui suit les surfaces réelles visées par la manette droite. */
  private createReticle(): void {
    const ring = new Mesh(new RingGeometry(0.015, 0.02, 32).rotateX(-Math.PI / 2), this.reticleMaterial);
    this.reticle = this.world.createTransformEntity(ring);
    this.reticle.addComponent(EnvironmentRaycastTarget, {
      space: RaycastSpace.Right,
      maxDistance: 5,
    });
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
