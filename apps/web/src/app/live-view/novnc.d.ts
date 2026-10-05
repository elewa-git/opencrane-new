declare module '@novnc/novnc/lib/rfb.js' {
  export interface RawChannel {
    send(data: ArrayBuffer | ArrayBufferView<ArrayBuffer>): void;
    close(): void;
    binaryType: BinaryType;
    readonly protocol: string;
    readonly readyState: number;
    onopen: ((event: Event) => void) | null;
    onmessage: ((event: MessageEvent) => void) | null;
    onerror: ((event: Event) => void) | null;
    onclose: ((event: CloseEvent) => void) | null;
  }
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, socket: WebSocket | RawChannel);
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    focusOnClick: boolean;
    disconnect(): void;
  }
}
