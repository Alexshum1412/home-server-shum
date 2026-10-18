/**
 * The ringing sound of a call: two short beeps every two seconds, made with the Web Audio API (no
 * sound file to ship). A browser lets a page make sound only after the person touched it once; if it
 * has not happened yet the call still rings visibly and, on a phone, by vibration.
 */
let context: AudioContext | null = null;
let timer: ReturnType<typeof setInterval> | undefined;

function audio(): AudioContext | null {
  if (context) return context;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    context = new Ctor();
  } catch {
    context = null;
  }
  return context;
}

/** Wakes the audio engine on the first touch, so a later incoming call can ring. */
export function unlockAudioOnFirstTouch(): void {
  const unlock = () => {
    void audio()?.resume();
    document.removeEventListener('pointerdown', unlock);
    document.removeEventListener('keydown', unlock);
  };
  document.addEventListener('pointerdown', unlock);
  document.addEventListener('keydown', unlock);
}

function beep(ctx: AudioContext, start: number, frequency: number): void {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(0.12, start + 0.03);
  gain.gain.linearRampToValueAtTime(0, start + 0.4);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.45);
}

function cycle(kind: 'incoming' | 'outgoing'): void {
  const ctx = audio();
  if (ctx && ctx.state === 'running') {
    const now = ctx.currentTime;
    // The caller hears a calmer tone than the one who is being called.
    beep(ctx, now, kind === 'incoming' ? 523 : 440);
    beep(ctx, now + 0.5, kind === 'incoming' ? 659 : 440);
  }
  if (kind === 'incoming') navigator.vibrate?.([300, 150, 300]);
}

export function ring(kind: 'incoming' | 'outgoing' | null): void {
  clearInterval(timer);
  timer = undefined;
  if (kind === null) {
    navigator.vibrate?.(0);
    return;
  }
  void audio()?.resume();
  cycle(kind);
  timer = setInterval(() => cycle(kind), 2000);
}
