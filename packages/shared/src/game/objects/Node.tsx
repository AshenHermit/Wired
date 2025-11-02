import * as React from "react";

export interface ComponentData {
  type: string;
  props: Record<string, any>;
}

export interface NodeApi {
  name: string;
  getPath: () => string;
  childNodes: React.RefObject<Record<string, NodeApi>>;
  childComponents: ComponentData[];
}

export const NodeContext = React.createContext<NodeApi | null>(null);

export function useNode(): NodeApi | null {
  const context = React.useContext(NodeContext);
  return context;
}

export function useNodeApiRef(): React.RefObject<NodeApi | null> {
  const ref = React.useRef<NodeApi>(null);
  return ref;
}

export const Node = React.forwardRef<
  NodeApi,
  React.PropsWithChildren<{ name: string }>
>(({ children, name }, ref) => {
  const parentNode = useNode();
  const childNodes = React.useRef<Record<string, NodeApi>>({});

  const getPath = React.useCallback(() => {
    if (!parentNode) return name;
    return `${parentNode.getPath()}/${name}`;
  }, []);

  const getAPI = React.useCallback(() => {
    const childComponents: ComponentData[] = React.Children.map(
      children,
      (child) => {
        if (React.isValidElement(child)) {
          if (typeof child.type === "function") {
            return {
              type: child.type.prototype.constructor.name,
              props: child.props,
            };
          } else if (typeof child.type === "object") {
            if ((child.type as any).displayName) {
              return {
                type: (child.type as any).displayName,
                props: child.props,
              };
            }
          }
        }
        return null;
      }
    )?.filter((component) => component !== null) as ComponentData[];

    return { name, getPath, childNodes: childNodes, childComponents };
  }, [name, getPath, childNodes.current, children]);

  React.useImperativeHandle(
    ref,
    () => {
      return getAPI();
    },
    [getAPI]
  );

  React.useEffect(() => {
    setTimeout(() => {
      console.log(childNodes.current);
    }, 1000);
    if (!parentNode) return;
    parentNode.childNodes.current[name] = getAPI();
    return () => {
      delete parentNode.childNodes.current[name];
    };
  }, [parentNode]);

  return (
    <NodeContext.Provider value={getAPI()}>{children}</NodeContext.Provider>
  );
});
Node.displayName = "Node";
