export interface Delivery {
  type: 'member' | 'ready' | 'resync' | 'refused';
  position: number;
  generation: number;
  memberId?: string;
}
export interface Replica { pid: number; port: number }

export function checkReplicas(_first: Replica, _second: Replica): void {}
export function checkDelivery(_actual: Delivery[], _expected: Delivery[]): void {}
export function checkClosure(_messages: Delivery[], _code: number,
  _expectedCode: number, _terminal: 'refused' | 'resync'): void {}
