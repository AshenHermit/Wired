import { Node } from "./objects";

type Ctor<T> = new (...args: any[]) => T;

const registry = new Map<string, Ctor<Node>>();

export function registerNode(className: string, ctor: Ctor<Node>) {
  registry.set(className, ctor);
}

export function getNodeCtor(className: string): Ctor<Node> | undefined {
  return registry.get(className);
}

export function RegisteredNode(name: string): ClassDecorator {
  return (constructor: Function): void => {
    registerNode(name, constructor as unknown as Ctor<Node>);
  };
}
