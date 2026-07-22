import type { WsEvent } from "../types";

export type Broadcaster = (event: WsEvent) => void;
