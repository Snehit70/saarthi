export type WindowId = `0x${string}`;

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface HyprWorkspace {
  id: number;
  name: string;
}

export interface HyprClient {
  address: WindowId;
  class: string;
  title: string;
  workspace: HyprWorkspace;
  monitor: number;
  floating: boolean;
  fullscreen: boolean;
  mapped: boolean;
  hidden: boolean;
  at: [number, number];
  size: [number, number];
}

export interface WindowInfo {
  id: WindowId;
  class: string;
  title: string;
  workspace: string;
  monitor: number;
  floating: boolean;
  fullscreen: boolean;
  focused: boolean;
  mapped: boolean;
  hidden: boolean;
  position: Point;
  size: Size;
}

export interface MonitorInfo {
  id: number;
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  focused: boolean;
}
