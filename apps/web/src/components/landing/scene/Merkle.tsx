"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { CADENCE_S, COLORS, LEDGER_Y, MERKLE, OUTPUT_CHUNKS, ROOT_LAND_AT, shared, smoothstep } from "./layout";

/**
 * hush-credit's only on-chain footprint per cadence tick: consumed vouchers (leaves) hash up into one Merkle root,
 * which drops through the veil onto HushLedger. Ticks with no calls still commit (a padded batch), so commit timing
 * says nothing about activity.
 */

// Leaves consumed per batch, cycling. Zeros are padded (empty) batches — the root still lands on time.
const LEAVES_PER_BATCH = [8, 5, 0, 7, 3, 8, 1, 0];
const DROP_FROM = 0.74;

const nodeVertex = /* glsl */ `
  uniform float uCycle;
  uniform float uLeaves;
  uniform float uVis;
  uniform float uPixelRatio;
  attribute float aAct;
  attribute float aLevel;
  attribute float aIndex;
  varying float vLit;
  varying float vLeaf;

  void main() {
    float enabled = aLevel < 0.5 ? step(aIndex + 0.5, uLeaves) : 1.0;
    float lit = smoothstep(aAct, aAct + 0.03, uCycle) * enabled * (1.0 - smoothstep(0.9, 0.99, uCycle));
    if (aLevel > 2.5) lit *= 1.0 - smoothstep(${DROP_FROM - 0.01}, ${DROP_FROM + 0.01}, uCycle); // the root leaves for the chain
    vLit = lit;
    vLeaf = aLevel < 0.5 ? 1.0 : 0.0;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = (aLevel < 0.5 ? 0.9 : 1.0 + aLevel * 0.15) * (1.0 + lit * 0.5) * 50.0 * uPixelRatio / -mv.z;
  }
`;

const nodeFragment = /* glsl */ `
  uniform float uVis;
  uniform vec3 uCyan;
  uniform vec3 uViolet;
  varying float vLit;
  varying float vLeaf;

  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float sq = max(abs(p.x), abs(p.y));
    float box = 1.0 - smoothstep(0.34, 0.5, sq);
    float outline = box * smoothstep(0.24, 0.34, sq);
    float shape = mix(outline * 0.7, box, vLit);
    vec3 col = mix(uCyan, uViolet, vLeaf) * (1.0 + vLit * 0.8); // leaves = vouchers (violet), hashes = cyan
    float a = shape * uVis * (0.3 + 0.7 * vLit);
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
    ${OUTPUT_CHUNKS}
  }
`;

const edgeVertex = /* glsl */ `
  uniform float uCycle;
  attribute float aAct;
  varying float vLit;
  void main() {
    vLit = smoothstep(aAct, aAct + 0.03, uCycle) * (1.0 - smoothstep(0.9, 0.99, uCycle));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const edgeFragment = /* glsl */ `
  uniform float uVis;
  uniform vec3 uCyan;
  varying float vLit;
  void main() {
    gl_FragColor = vec4(uCyan, uVis * (0.14 + 0.6 * vLit));
    ${OUTPUT_CHUNKS}
  }
`;

interface TreeNode {
  pos: THREE.Vector3;
  level: number;
  index: number;
  act: number;
}

function buildTree() {
  const nodes: TreeNode[] = [];
  const levels: TreeNode[][] = [];
  for (let level = 0, width = 8; width >= 1; level++, width /= 2) {
    const spacing = 0.28 * 2 ** level;
    const row: TreeNode[] = [];
    for (let i = 0; i < width; i++) {
      // leaves light one by one as vouchers are consumed; each level hashes a beat after the one below
      const act = level === 0 ? 0.05 + i * 0.055 : 0.52 + (level - 1) * 0.08 + i * 0.02;
      row.push({
        pos: new THREE.Vector3(MERKLE.x + (i - (width - 1) / 2) * spacing, MERKLE.leafY - level * MERKLE.levelGap, MERKLE.z),
        level,
        index: i,
        act,
      });
    }
    levels.push(row);
    nodes.push(...row);
  }
  const edges: { a: THREE.Vector3; b: THREE.Vector3; act: number }[] = [];
  for (let level = 1; level < levels.length; level++) {
    for (const parent of levels[level]!) {
      for (const child of [levels[level - 1]![parent.index * 2]!, levels[level - 1]![parent.index * 2 + 1]!]) {
        edges.push({ a: child.pos, b: parent.pos, act: parent.act });
      }
    }
  }
  return { nodes, edges, root: levels[levels.length - 1]![0]!.pos };
}

export function Merkle() {
  const drop = useRef<THREE.Mesh>(null);
  const { nodeGeo, nodeMat, edgeGeo, edgeMat, root, uniforms } = useMemo(() => {
    const { nodes, edges, root } = buildTree();
    const uniforms = {
      uCycle: { value: 0 },
      uLeaves: { value: 8 },
      uVis: { value: 0 },
      uPixelRatio: shared.uPixelRatio,
      uCyan: { value: COLORS.cyan },
      uViolet: { value: COLORS.violet },
    };

    const nodeGeo = new THREE.BufferGeometry();
    nodeGeo.setAttribute("position", new THREE.Float32BufferAttribute(nodes.flatMap((n) => n.pos.toArray()), 3));
    nodeGeo.setAttribute("aAct", new THREE.Float32BufferAttribute(nodes.map((n) => n.act), 1));
    nodeGeo.setAttribute("aLevel", new THREE.Float32BufferAttribute(nodes.map((n) => n.level), 1));
    nodeGeo.setAttribute("aIndex", new THREE.Float32BufferAttribute(nodes.map((n) => n.index), 1));
    const nodeMat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: nodeVertex,
      fragmentShader: nodeFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute("position", new THREE.Float32BufferAttribute(edges.flatMap((e) => [...e.a.toArray(), ...e.b.toArray()]), 3));
    edgeGeo.setAttribute("aAct", new THREE.Float32BufferAttribute(edges.flatMap((e) => [e.act, e.act]), 1));
    const edgeMat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: edgeVertex,
      fragmentShader: edgeFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    return { nodeGeo, nodeMat, edgeGeo, edgeMat, root, uniforms };
  }, []);

  useEffect(
    () => () => {
      nodeGeo.dispose();
      nodeMat.dispose();
      edgeGeo.dispose();
      edgeMat.dispose();
    },
    [nodeGeo, nodeMat, edgeGeo, edgeMat],
  );

  useFrame(() => {
    const t = shared.uTime.value;
    const cycle = (t / CADENCE_S) % 1;
    const batch = Math.floor(t / CADENCE_S);
    uniforms.uCycle.value = cycle;
    uniforms.uLeaves.value = LEAVES_PER_BATCH[batch % LEAVES_PER_BATCH.length]!;
    // Merkle batches exist only in hush-credit, and the tree is introduced in HOW IT WORKS.
    const vis = smoothstep(1.55, 2.05, shared.uProgress.value) * shared.uHush.value;
    uniforms.uVis.value = vis;

    const m = drop.current;
    if (!m) return;
    const s = (cycle - DROP_FROM) / (ROOT_LAND_AT - DROP_FROM);
    m.visible = vis > 0.01 && s >= 0 && s <= 1;
    if (m.visible) {
      m.position.set(root.x, THREE.MathUtils.lerp(root.y, LEDGER_Y + 0.07, s * s), root.z);
      m.scale.setScalar(vis);
      m.rotation.y = t * 3;
    }
  });

  return (
    <>
      <lineSegments geometry={edgeGeo} material={edgeMat} frustumCulled={false} />
      <points geometry={nodeGeo} material={nodeMat} frustumCulled={false} />
      <mesh ref={drop} visible={false}>
        <boxGeometry args={[0.13, 0.13, 0.13]} />
        <meshBasicMaterial color={COLORS.cyan.clone().multiplyScalar(2.2)} toneMapped={false} />
      </mesh>
    </>
  );
}
