/**
 * Modo Random para un juego tipo PokéRogue.
 *
 * - Cada Pokémon CAPTURADO recibe estadísticas, habilidad, pasiva y ataques aleatorios.
 * - El jefe final de cada partida es un legendario aleatorio con estadísticas propias.
 * - El Pokémon inicial NO se toca: su elección sigue las reglas normales del juego.
 *
 * Todo es determinista a partir de la semilla de la partida (runSeed), así que
 * una run se puede reproducir y no cambia al recargar la página.
 *
 * El módulo no depende del código de PokéRogue: tú le pasas los "pools" (listas de
 * IDs) desde tus datos del juego y él devuelve los valores a aplicar.
 */

// ───────────────────────── Tipos ─────────────────────────

export type StatKey = "hp" | "atk" | "def" | "spAtk" | "spDef" | "spd";
export type Stats = Record<StatKey, number>;
const STAT_KEYS: StatKey[] = ["hp", "atk", "def", "spAtk", "spDef", "spd"];

export interface MoveInfo {
  id: number;
  damaging: boolean; // true si es ataque de daño (físico/especial)
  power: number; // potencia base (0 si no aplica)
}

export interface LegendaryInfo {
  speciesId: number;
}

export interface Pools {
  abilities: number[]; // IDs de habilidades permitidas
  moves: MoveInfo[]; // movimientos permitidos
  legendaries: LegendaryInfo[]; // legendarios elegibles como jefe final
}

export interface RandomMonData {
  stats: Stats;
  abilityId: number;
  passiveId: number;
  moveIds: number[];
}

export interface BossData extends RandomMonData {
  speciesId: number;
}

export interface RandomModeConfig {
  /** Variación del total de estadísticas (BST) respecto al original: 0.25 = ±25 %. */
  bstVariance: number;
  minStat: number;
  maxStat: number;
  bstMin: number; // límites absolutos del BST de un capturado
  bstMax: number;
  boss: { bstMin: number; bstMax: number; minDamaging: number; minMovePower: number };
  bannedMoveIds: number[];
  bannedAbilityIds: number[];
}

export const DEFAULT_CONFIG: RandomModeConfig = {
  bstVariance: 0.25,
  minStat: 10,
  maxStat: 255,
  bstMin: 200,
  bstMax: 720,
  boss: { bstMin: 680, bstMax: 800, minDamaging: 2, minMovePower: 80 },
  bannedMoveIds: [],
  bannedAbilityIds: [],
};

// ───────────────────────── RNG con semilla ─────────────────────────

function hashSeed(s: string): number {
  // FNV-1a de 32 bits
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  private state: number;
  constructor(seed: string) {
    this.state = hashSeed(seed);
  }
  /** Número en [0, 1) — mulberry32 */
  float(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Entero en [min, max] ambos incluidos */
  int(min: number, max: number): number {
    return min + Math.floor(this.float() * (max - min + 1));
  }
  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.float() * arr.length)];
  }
  /** Devuelve `n` elementos distintos del arreglo */
  sample<T>(arr: T[], n: number): T[] {
    const copy = [...arr];
    const out: T[] = [];
    while (out.length < n && copy.length) {
      out.push(copy.splice(Math.floor(this.float() * copy.length), 1)[0]);
    }
    return out;
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ───────────────────────── Generadores ─────────────────────────

/** Reparte `total` puntos entre las 6 estadísticas respetando mínimo y máximo. */
function distribute(rng: Rng, total: number, min: number, max: number): Stats {
  total = clamp(total, min * 6, max * 6);
  // Pesos exponenciales: dan perfiles variados (algunos muy sesgados) sin dejar ninguna stat en 0.
  const w = {} as Record<StatKey, number>;
  for (const k of STAT_KEYS) w[k] = -Math.log(1 - rng.float()) + 0.35;

  const out = {} as Stats;
  let free = [...STAT_KEYS];
  let remaining = total;
  while (free.length) {
    const sumW = free.reduce((a, k) => a + w[k], 0);
    const violator = free.find((k) => {
      const v = (remaining * w[k]) / sumW;
      return v < min || v > max;
    });
    if (!violator) {
      for (const k of free) out[k] = Math.round((remaining * w[k]) / sumW);
      break;
    }
    const c = clamp((remaining * w[violator]) / sumW, min, max);
    out[violator] = Math.round(c);
    remaining -= c;
    free = free.filter((k) => k !== violator);
  }
  return out;
}

export function randomizeStats(rng: Rng, baseBst: number, cfg: RandomModeConfig): Stats {
  const factor = 1 + (rng.float() * 2 - 1) * cfg.bstVariance;
  const bst = clamp(Math.round(baseBst * factor), cfg.bstMin, cfg.bstMax);
  return distribute(rng, bst, cfg.minStat, cfg.maxStat);
}

export function randomizeMoveset(
  rng: Rng,
  pool: MoveInfo[],
  count = 4,
  minDamaging = 1,
  minPower = 0,
): number[] {
  const damaging = pool.filter((m) => m.damaging && m.power >= minPower);
  const chosen = rng.sample(damaging, Math.min(minDamaging, damaging.length));
  const ids = new Set(chosen.map((m) => m.id));
  const rest = pool.filter((m) => !ids.has(m.id));
  const extra = rng.sample(rest, count - chosen.length);
  return [...chosen, ...extra].map((m) => m.id);
}

// ───────────────────────── Estado de la partida ─────────────────────────

export class RandomModeRun {
  private pools: Pools;
  private bossCache?: BossData;
  private monCache = new Map<string, RandomMonData>();

  constructor(
    public readonly runSeed: string,
    pools: Pools,
    private cfg: RandomModeConfig = DEFAULT_CONFIG,
  ) {
    this.pools = {
      abilities: pools.abilities.filter((id) => !cfg.bannedAbilityIds.includes(id)),
      moves: pools.moves.filter((m) => !cfg.bannedMoveIds.includes(m.id)),
      legendaries: pools.legendaries,
    };
  }

  /**
   * Datos aleatorios para un Pokémon recién capturado.
   * `captureIndex` = nº de captura en la run (0, 1, 2…): así dos Pokémon de la
   * misma especie salen distintos, pero la run sigue siendo reproducible.
   */
  forCaptured(speciesId: number, baseBst: number, captureIndex: number): RandomMonData {
    const key = `${speciesId}:${captureIndex}`;
    const cached = this.monCache.get(key);
    if (cached) return cached;

    const rng = new Rng(`${this.runSeed}|mon|${key}`);
    const data: RandomMonData = {
      stats: randomizeStats(rng, baseBst, this.cfg),
      abilityId: rng.pick(this.pools.abilities),
      passiveId: rng.pick(this.pools.abilities),
      moveIds: randomizeMoveset(rng, this.pools.moves, 4, 1),
    };
    this.monCache.set(key, data);
    return data;
  }

  /** Jefe final de la run: legendario aleatorio con estadísticas, habilidad y ataques fuertes. */
  finalBoss(): BossData {
    if (this.bossCache) return this.bossCache;

    const rng = new Rng(`${this.runSeed}|boss`);
    const { bstMin, bstMax, minDamaging, minMovePower } = this.cfg.boss;
    const legendary = rng.pick(this.pools.legendaries);

    this.bossCache = {
      speciesId: legendary.speciesId,
      stats: distribute(rng, rng.int(bstMin, bstMax), 40, this.cfg.maxStat),
      abilityId: rng.pick(this.pools.abilities),
      passiveId: rng.pick(this.pools.abilities),
      moveIds: randomizeMoveset(rng, this.pools.moves, 4, minDamaging, minMovePower),
    };
    return this.bossCache;
  }
}

// ───────────────────────── Ejemplo de uso ─────────────────────────
//
// const run = new RandomModeRun(
//   "mi-semilla-123",
//   { abilities: [...ids], moves: [...movesInfo], legendaries: [{ speciesId: 150 }, ...] },
// );
//
// // Al capturar un Pokémon:
// const r = run.forCaptured(species.id, baseStatTotal, capturedCount);
// pokemon.stats = r.stats; pokemon.ability = r.abilityId; pokemon.moveset = r.moveIds;
//
// // Al llegar a la última oleada:
// const boss = run.finalBoss();
