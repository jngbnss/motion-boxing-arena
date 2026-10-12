// 생성 GLB 를 웹과 같은 three.js GLTFLoader 로 읽어 계약(C3/C5, contracts §AI worker)을 검사한다.
// 사용: node workers/ai/scripts/check_glb.mjs <file.glb> [...]   (three 는 apps/web/node_modules 에서 가져온다)
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const threeRoot = resolve(here, '../../../apps/web/node_modules/three');
const THREE = await import(pathToFileURL(resolve(threeRoot, 'build/three.module.js')).href);
const { GLTFLoader } = await import(pathToFileURL(resolve(threeRoot, 'examples/jsm/loaders/GLTFLoader.js')).href);

// packages/shared/src/skeleton.ts BONES 와 동일
const BONES = [
  'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
  'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
];
const PARENT = {
  Spine: 'Hips', Spine1: 'Spine', Spine2: 'Spine1', Neck: 'Spine2', Head: 'Neck',
  LeftShoulder: 'Spine2', LeftArm: 'LeftShoulder', LeftForeArm: 'LeftArm', LeftHand: 'LeftForeArm',
  RightShoulder: 'Spine2', RightArm: 'RightShoulder', RightForeArm: 'RightArm', RightHand: 'RightForeArm',
  LeftUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg', LeftToeBase: 'LeftFoot',
  RightUpLeg: 'Hips', RightLeg: 'RightUpLeg', RightFoot: 'RightLeg', RightToeBase: 'RightFoot',
};

function parse(buf) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((ok, fail) => new GLTFLoader().parse(ab, '', ok, fail));
}

async function check(file) {
  const gltf = await parse(readFileSync(file));
  const errors = [];
  const meshes = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
  if (meshes.length !== 1) errors.push(`SkinnedMesh ${meshes.length}개 (1개여야 함)`);
  const mesh = meshes[0];
  const bones = mesh.skeleton.bones;
  const names = bones.map((b) => b.name);
  if (JSON.stringify(names) !== JSON.stringify(BONES)) errors.push(`뼈 이름/순서 불일치: ${names.join(',')}`);
  for (const b of bones) {
    const want = PARENT[b.name];
    if (want && b.parent?.name !== want) errors.push(`${b.name} 부모 ${b.parent?.name} ≠ ${want}`);
    if (Math.abs(b.quaternion.w - 1) > 1e-6) errors.push(`${b.name} 레스트 회전이 항등이 아님`);
  }
  const geo = mesh.geometry;
  for (const a of ['position', 'normal', 'skinIndex', 'skinWeight']) if (!geo.getAttribute(a)) errors.push(`${a} 속성 없음`);
  const hasColor = !!geo.getAttribute('color');
  const tris = (geo.index ? geo.index.count : geo.getAttribute('position').count) / 3;
  if (tris > 20000) errors.push(`삼각형 ${tris} > 20000`);
  const sw = geo.getAttribute('skinWeight');
  let maxInfl = 0;
  for (let i = 0; i < sw.count; i++) {
    const s = sw.getX(i) + sw.getY(i) + sw.getZ(i) + sw.getW(i);
    if (Math.abs(s - 1) > 1e-3) { errors.push(`정점 ${i} 가중치 합 ${s}`); break; }
    maxInfl = Math.max(maxInfl, [sw.getX(i), sw.getY(i), sw.getZ(i), sw.getW(i)].filter((w) => w > 0).length);
  }
  // 레스트 포즈 스키닝 결과 = 원래 위치 (inverseBindMatrices 정합)
  const pos = geo.getAttribute('position');
  const v = new THREE.Vector3();
  let maxSkinErr = 0;
  const box = new THREE.Box3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const orig = v.clone();
    mesh.applyBoneTransform(i, v);
    maxSkinErr = Math.max(maxSkinErr, v.distanceTo(orig));
    box.expandByPoint(v);
  }
  if (maxSkinErr > 1e-4) errors.push(`레스트 스키닝 오차 ${maxSkinErr}`);
  const size = box.getSize(new THREE.Vector3());
  if (Math.abs(size.y - 1.8) > 0.01) errors.push(`키 ${size.y.toFixed(3)} ≠ 1.8`);
  if (Math.abs(box.min.y) > 0.01) errors.push(`발 y=${box.min.y.toFixed(3)} ≠ 0`);
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
  const w = (n) => bones[BONES.indexOf(n)].getWorldPosition(new THREE.Vector3());
  const armDeg = (side) => {
    const a = w(`${side}Arm`), h = w(`${side}Hand`);
    return THREE.MathUtils.radToDeg(Math.atan2(a.y - h.y, Math.abs(h.x - a.x)));
  };
  const left = armDeg('Left'), right = armDeg('Right');
  if (Math.abs(left - 45) > 3 || Math.abs(right - 45) > 3) errors.push(`A-pose 아님: 팔 ${left.toFixed(1)}°/${right.toFixed(1)}°`);
  if (!(w('LeftHand').x > 0 && w('RightHand').x < 0)) errors.push('왼손이 +X 가 아님');
  // 포즈 적용 스모크: 왼팔 90° 들기 → 왼손이 어깨보다 위
  bones[BONES.indexOf('LeftArm')].rotation.z = Math.PI / 2;
  gltf.scene.updateMatrixWorld(true);
  if (!(w('LeftHand').y > w('LeftArm').y)) errors.push('LeftArm 회전이 손을 올리지 못함');
  const report = {
    file, ok: errors.length === 0, errors,
    bones: names.length, tris, verts: pos.count, vertexColors: hasColor, maxInfluences: maxInfl,
    bbox: { min: box.min.toArray().map((x) => +x.toFixed(4)), max: box.max.toArray().map((x) => +x.toFixed(4)) },
    center: { x: +cx.toFixed(4), z: +cz.toFixed(4) }, armDeg: { left: +left.toFixed(1), right: +right.toFixed(1) },
    material: mesh.material.type, extras: gltf.parser.json.extras,
  };
  return report;
}

let failed = false;
for (const f of process.argv.slice(2)) {
  const r = await check(f);
  console.log(JSON.stringify(r, null, 1));
  failed ||= !r.ok;
}
process.exit(failed ? 1 : 0);
