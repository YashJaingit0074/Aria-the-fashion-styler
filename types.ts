
export interface Outfit {
  top: string;
  bottom: string;
  footwear: string;
  accessories: string[];
  colorPalette: string[];
  vibe: string;
}

export interface StylingRequest {
  ownedItems: string;
  location: string;
  occasion: string;
  preference: string;
}

export interface FashionTip {
  title: string;
  description: string;
  category: 'color' | 'weather' | 'cultural' | 'accessory';
}

export enum AppState {
  IDLE = 'IDLE',
  CONNECTING = 'CONNECTING',
  LISTENING = 'LISTENING',
  SPEAKING = 'SPEAKING',
  ERROR = 'ERROR'
}
