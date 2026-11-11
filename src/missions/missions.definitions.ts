/**
 * Daily missions. Progress resets at 00:00 UTC. Games report progress
 * through MissionsService (`increment` for counters, `raiseTo` for "best
 * in a round"); add a game's missions here and call those from its service.
 */
export interface MissionDef {
  id: string;
  /** Game the mission belongs to (the UI links to it). */
  game: 'poop';
  title: string;
  description: string;
  /** Progress needed to claim. */
  target: number;
  /** Unit shown next to progress, e.g. "rounds". */
  unit: string;
  /** Coins credited on claim. */
  reward: number;
}

export const MISSIONS: readonly MissionDef[] = [
  {
    id: 'poop_play_5',
    game: 'poop',
    title: 'Regular',
    description: 'Play 5 rounds of Poop',
    target: 5,
    unit: 'rounds',
    reward: 50,
  },
  {
    id: 'poop_streak_2',
    game: 'poop',
    title: 'Double right',
    description: 'Make 2 correct choices in a row',
    target: 2,
    unit: 'in a row',
    reward: 30,
  },
  {
    id: 'poop_reach_760',
    game: 'poop',
    title: 'High climber',
    description: 'Reach 7.60× in a Poop round (clear stage 3)',
    target: 3,
    unit: 'stages',
    reward: 100,
  },
];

export const missionById = (id: string) => MISSIONS.find((m) => m.id === id);
