/** `mm:ss.t` display of a duration in seconds (e.g. `1:23.4`). */
export function formatDuration(seconds: number): string {
    const total = Math.max(0, seconds);
    const m = Math.floor(total / 60);
    const s = total - m * 60;
    const whole = Math.floor(s);
    const tenth = Math.floor((s - whole) * 10);
    return `${m}:${whole.toString().padStart(2, '0')}.${tenth}`;
}
