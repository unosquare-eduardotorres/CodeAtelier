/**
 * Subtle background ambiance for empty chat states.
 * Replaced the 16-robot CSS keyframe animation with a performant
 * CSS radial-gradient pattern — zero JS, zero style tag, no animation overhead.
 */
export default function FloatingRobots(): React.JSX.Element {
  return (
    <div
      className="absolute inset-0 overflow-hidden pointer-events-none z-0 opacity-[0.03]"
      style={{
        backgroundImage: `
          radial-gradient(ellipse 600px 400px at 20% 30%, oklch(0.585 0.233 277 / 0.4), transparent),
          radial-gradient(ellipse 500px 300px at 75% 60%, oklch(0.585 0.233 277 / 0.3), transparent),
          radial-gradient(ellipse 400px 250px at 50% 85%, oklch(0.65 0.2 155 / 0.2), transparent)
        `
      }}
    />
  )
}
