import { Bot } from 'lucide-react';

const robots = [
  // Large accent robots — the "hero" pieces
  { id: 1, size: 48, top: '8%', left: '12%', duration: 24, delay: 0, opacity: 0.07 },
  { id: 2, size: 56, top: '30%', left: '78%', duration: 28, delay: -4, opacity: 0.06 },
  { id: 3, size: 44, top: '65%', left: '50%', duration: 22, delay: -9, opacity: 0.07 },
  { id: 4, size: 52, top: '80%', left: '85%', duration: 26, delay: -2, opacity: 0.06 },

  // Medium robots — fill the middle ground
  { id: 5, size: 36, top: '18%', left: '45%', duration: 20, delay: -7, opacity: 0.08 },
  { id: 6, size: 32, top: '45%', left: '20%', duration: 25, delay: -12, opacity: 0.09 },
  { id: 7, size: 34, top: '55%', left: '70%', duration: 21, delay: -5, opacity: 0.08 },
  { id: 8, size: 38, top: '75%', left: '30%', duration: 27, delay: -14, opacity: 0.07 },
  { id: 9, size: 30, top: '12%', left: '65%', duration: 23, delay: -10, opacity: 0.09 },
  { id: 10, size: 34, top: '40%', left: '88%', duration: 19, delay: -6, opacity: 0.08 },

  // Small robots — add depth and density
  { id: 11, size: 22, top: '5%', left: '35%', duration: 18, delay: -3, opacity: 0.1 },
  { id: 12, size: 20, top: '35%', left: '5%', duration: 26, delay: -11, opacity: 0.1 },
  { id: 13, size: 24, top: '90%', left: '55%', duration: 22, delay: -8, opacity: 0.1 },
  { id: 14, size: 18, top: '22%', left: '92%', duration: 20, delay: -15, opacity: 0.11 },
  { id: 15, size: 20, top: '58%', left: '38%', duration: 24, delay: -1, opacity: 0.1 },
  { id: 16, size: 22, top: '48%', left: '58%', duration: 30, delay: -13, opacity: 0.09 }
];

export default function FloatingRobots(): React.JSX.Element {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none z-0">
      {robots.map((robot) => (
        <div
          key={robot.id}
          className="absolute text-indigo-400"
          style={{
            top: robot.top,
            left: robot.left,
            opacity: robot.opacity,
            animation: `float-${robot.id} ${robot.duration}s ease-in-out infinite`,
            animationDelay: `${robot.delay}s`
          }}
        >
          <Bot size={robot.size} strokeWidth={1.5} />
        </div>
      ))}

      <style>{`
        ${robots
          .map(
            (r) => `
          @keyframes float-${r.id} {
            0%, 100% { transform: translate(0, 0) rotate(0deg) scale(1); }
            25% { transform: translate(${18 + r.id * 2}px, -${25 + r.id * 3}px) rotate(${6 + r.id * 0.8}deg) scale(${1 + r.id * 0.005}); }
            50% { transform: translate(-${14 + r.id * 3}px, ${18 + r.id * 2}px) rotate(-${4 + r.id * 0.6}deg) scale(${1 - r.id * 0.003}); }
            75% { transform: translate(${22 + r.id * 1.5}px, ${12 + r.id * 2.5}px) rotate(${5 + r.id * 0.7}deg) scale(1); }
          }
        `
          )
          .join('\n')}
      `}</style>
    </div>
  );
}
