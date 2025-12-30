
import React, { useRef } from 'react';
import { Canvas, useFrame, ThreeElements } from '@react-three/fiber';
import { PerspectiveCamera, OrbitControls, Stars, Float } from '@react-three/drei';
import * as THREE from 'three';

// Fix for JSX intrinsic elements errors by augmenting the React.JSX namespace.
// This ensures that Three.js elements like <group>, <mesh>, <boxGeometry>, etc., 
// are correctly recognized by TypeScript in modern React environments.
declare global {
  namespace React {
    namespace JSX {
      interface IntrinsicElements extends ThreeElements {}
    }
  }
}

interface AvatarProps {
  isSpeaking: boolean;
  amplitude: number;
}

const FashionRobot: React.FC<AvatarProps> = ({ isSpeaking, amplitude }) => {
  const headRef = useRef<THREE.Group>(null);
  const leftEyeRef = useRef<THREE.Mesh>(null);
  const rightEyeRef = useRef<THREE.Mesh>(null);
  const coreRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    const t = state.clock.getElapsedTime();
    
    // Head movement
    if (headRef.current) {
      headRef.current.rotation.y = Math.sin(t * 0.5) * 0.15;
      headRef.current.rotation.x = Math.cos(t * 0.3) * 0.05;
      headRef.current.position.y = 1.6 + Math.sin(t * 2) * 0.02 + (isSpeaking ? amplitude * 0.1 : 0);
    }

    // Eye reactivity
    const eyeColor = isSpeaking 
      ? new THREE.Color('#d4af37').lerp(new THREE.Color('#ffffff'), amplitude)
      : new THREE.Color('#00f2ff');
    const eyeIntensity = isSpeaking ? 2 + amplitude * 10 : 1;

    if (leftEyeRef.current && rightEyeRef.current) {
      (leftEyeRef.current.material as THREE.MeshStandardMaterial).emissive = eyeColor;
      (leftEyeRef.current.material as THREE.MeshStandardMaterial).emissiveIntensity = eyeIntensity;
      (rightEyeRef.current.material as THREE.MeshStandardMaterial).emissive = eyeColor;
      (rightEyeRef.current.material as THREE.MeshStandardMaterial).emissiveIntensity = eyeIntensity;
      
      // Eye scaling when speaking (digital blinking/reactive)
      const eyeScale = isSpeaking ? 1 + amplitude * 0.5 : 1;
      leftEyeRef.current.scale.set(eyeScale, eyeScale, eyeScale);
      rightEyeRef.current.scale.set(eyeScale, eyeScale, eyeScale);
    }

    // Core pulsing
    if (coreRef.current) {
      const coreScale = 1 + (isSpeaking ? amplitude * 0.2 : Math.sin(t * 3) * 0.05);
      coreRef.current.scale.set(coreScale, coreScale, coreScale);
      (coreRef.current.material as THREE.MeshStandardMaterial).emissiveIntensity = isSpeaking ? 2 + amplitude * 5 : 0.5;
    }
  });

  return (
    <group position={[0, -2, 0]}>
      {/* Robot Chest/Body */}
      <mesh position={[0, 0.8, 0]}>
        <boxGeometry args={[1, 1.2, 0.6]} />
        <meshStandardMaterial color="#111" metalness={0.9} roughness={0.1} />
      </mesh>
      
      {/* Glowing Core */}
      <mesh ref={coreRef} position={[0, 1, 0.31]}>
        <sphereGeometry args={[0.15, 32, 32]} />
        <meshStandardMaterial color="#d4af37" emissive="#d4af37" emissiveIntensity={1} />
      </mesh>

      {/* Shoulders */}
      <mesh position={[0.7, 1.3, 0]}>
        <sphereGeometry args={[0.2, 16, 16]} />
        <meshStandardMaterial color="#222" metalness={1} />
      </mesh>
      <mesh position={[-0.7, 1.3, 0]}>
        <sphereGeometry args={[0.2, 16, 16]} />
        <meshStandardMaterial color="#222" metalness={1} />
      </mesh>

      {/* Robot Head */}
      <group ref={headRef}>
        <mesh>
          <boxGeometry args={[0.6, 0.5, 0.5]} />
          <meshStandardMaterial color="#1a1a1a" metalness={1} roughness={0.1} />
        </mesh>
        
        {/* Left Eye */}
        <mesh ref={leftEyeRef} position={[-0.15, 0.05, 0.26]}>
          <sphereGeometry args={[0.06, 16, 16]} />
          <meshStandardMaterial color="#000" emissive="#00f2ff" emissiveIntensity={1} />
        </mesh>
        
        {/* Right Eye */}
        <mesh ref={rightEyeRef} position={[0.15, 0.05, 0.26]}>
          <sphereGeometry args={[0.06, 16, 16]} />
          <meshStandardMaterial color="#000" emissive="#00f2ff" emissiveIntensity={1} />
        </mesh>

        {/* Visor highlight */}
        <mesh position={[0, 0.05, 0.24]}>
          <boxGeometry args={[0.5, 0.15, 0.02]} />
          <meshStandardMaterial color="#000" transparent opacity={0.5} />
        </mesh>
      </group>

      {/* Floating Design Accents */}
      <Float speed={4} rotationIntensity={2} floatIntensity={1}>
        <mesh position={[1.5, 1, -1]}>
          <octahedronGeometry args={[0.1]} />
          <meshStandardMaterial color="#d4af37" emissive="#d4af37" emissiveIntensity={0.5} />
        </mesh>
      </Float>

      {/* Base */}
      <mesh position={[0, 0.05, 0]}>
        <cylinderGeometry args={[0.6, 0.8, 0.1, 32]} />
        <meshStandardMaterial color="#050505" />
      </mesh>
    </group>
  );
};

export const AvatarCanvas: React.FC<AvatarProps> = (props) => {
  return (
    <div className="absolute inset-0 z-0">
      <Canvas shadows dpr={[1, 2]}>
        <PerspectiveCamera makeDefault position={[0, 0.5, 4.5]} />
        <OrbitControls 
          enableZoom={false} 
          enablePan={false} 
          maxPolarAngle={Math.PI / 1.8} 
          minPolarAngle={Math.PI / 3}
        />
        <ambientLight intensity={0.2} />
        <spotLight position={[5, 10, 5]} angle={0.3} penumbra={1} intensity={1.5} castShadow />
        <pointLight position={[-5, 2, 2]} intensity={0.8} color="#d4af37" />
        <pointLight position={[0, -2, 2]} intensity={0.5} color="#00f2ff" />
        
        <Stars radius={50} depth={50} count={3000} factor={4} saturation={0} fade speed={1} />
        
        <FashionRobot {...props} />
        
        <gridHelper args={[20, 20, '#d4af37', '#111']} position={[0, -2, 0]} rotation={[0, 0, 0]} />
      </Canvas>
    </div>
  );
};
