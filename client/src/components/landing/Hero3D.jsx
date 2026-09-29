import { useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';

/**
 * The Mayhem Core: a glowing wireframe icosahedron orbited by a thin ring
 * of particles. Kept to a handful of low-poly meshes + one point cloud so
 * it stays cheap on mid-range phones — this is the only place in the app
 * that touches three.js.
 */
function MayhemCore({ mouse }) {
  const coreRef = useRef();
  const shellRef = useRef();
  const groupRef = useRef();

  useFrame((_, delta) => {
    if (coreRef.current) coreRef.current.rotation.y += delta * 0.18;
    if (shellRef.current) {
      shellRef.current.rotation.y -= delta * 0.09;
      shellRef.current.rotation.x += delta * 0.04;
    }
    if (groupRef.current) {
      const targetX = mouse.current.y * 0.18;
      const targetY = mouse.current.x * 0.22;
      groupRef.current.rotation.x += (targetX - groupRef.current.rotation.x) * 0.04;
      groupRef.current.rotation.y += (targetY - groupRef.current.rotation.y) * 0.04;
    }
  });

  return (
    <group ref={groupRef}>
      <mesh ref={coreRef}>
        <icosahedronGeometry args={[1.15, 1]} />
        <meshStandardMaterial
          color="#f0b800"
          emissive="#f0b800"
          emissiveIntensity={0.55}
          wireframe
          transparent
          opacity={0.85}
        />
      </mesh>
      <mesh ref={shellRef}>
        <icosahedronGeometry args={[1.85, 0]} />
        <meshStandardMaterial
          color="#22d3ee"
          emissive="#22d3ee"
          emissiveIntensity={0.3}
          wireframe
          transparent
          opacity={0.3}
        />
      </mesh>
    </group>
  );
}

function ParticleField() {
  const pointsRef = useRef();
  const positions = useMemo(() => {
    const count = 260;
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const radius = 3.2 + Math.random() * 3.5;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      arr[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      arr[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      arr[i * 3 + 2] = radius * Math.cos(phi);
    }
    return arr;
  }, []);

  useFrame((_, delta) => {
    if (pointsRef.current) pointsRef.current.rotation.y += delta * 0.02;
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial color="#4ade80" size={0.035} sizeAttenuation transparent opacity={0.55} />
    </points>
  );
}

function Scene({ mouse }) {
  return (
    <>
      <ambientLight intensity={0.4} />
      <pointLight position={[4, 3, 5]} intensity={40} color="#f0b800" />
      <pointLight position={[-4, -2, -3]} intensity={25} color="#22d3ee" />
      <MayhemCore mouse={mouse} />
      <ParticleField />
    </>
  );
}

export default function Hero3D() {
  const mouse = useRef({ x: 0, y: 0 });

  function handlePointerMove(e) {
    const { innerWidth, innerHeight } = window;
    mouse.current = {
      x: (e.clientX / innerWidth) * 2 - 1,
      y: (e.clientY / innerHeight) * 2 - 1,
    };
  }

  return (
    <div className="hero3d-canvas" onPointerMove={handlePointerMove}>
      <Canvas
        dpr={[1, 1.75]}
        camera={{ position: [0, 0, 6.2], fov: 45 }}
        gl={{ antialias: true, alpha: true }}
      >
        <Scene mouse={mouse} />
      </Canvas>
    </div>
  );
}
