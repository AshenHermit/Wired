import { Node } from "./objects";

type Ctor<T> = new (...args: any[]) => T;

export type NodesRegistryType = Map<string, Ctor<Node>>;

export function getNodeRegistry() {
  if (globalThis._nodesRegistry)
    return globalThis._nodesRegistry as NodesRegistryType;
  globalThis._nodesRegistry = new Map<string, Ctor<Node>>();
  return globalThis._nodesRegistry as NodesRegistryType;
}

export function registerNode(className: string, ctor: Ctor<Node>) {
  getNodeRegistry().set(className, ctor);
}

export function getNodeCtor(className: string): Ctor<Node> | undefined {
  return getNodeRegistry().get(className);
}
export function getNodeClassName<T extends Node>(node: T): string {
  return node.constructor.name;
}

export function RegisteredNode(name: string): ClassDecorator {
  return (constructor: Function): void => {
    constructor.prototype.className = name;
    registerNode(name, constructor as unknown as Ctor<Node>);
  };
}
