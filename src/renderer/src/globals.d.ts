import type { HappyPandaAPI } from '../../shared/types';

declare global {
  interface Window {
    readonly happyPanda?: HappyPandaAPI;
  }
}

export {};
