/** Color estable por usuario (mismo userId → mismo color en cursor y lista). */
export function userColor(userId: number): string {
  const hue = (userId * 137.508) % 360 // angulo dorado: colores bien separados
  return `hsl(${hue.toFixed(0)} 85% 60%)`
}
