import { createContext, useContext, useEffect, useState } from "react";
import { NetworkAPIBase } from "./NetworkAPIBase";

export interface NetworkContextType {
  api: NetworkAPIBase | null;
}

const NetworkContext = createContext<NetworkContextType>({
  api: null,
});

export function useNetwork() {
  const context = useContext(NetworkContext);
  if (!context) {
    throw new Error("useGame must be used within a GameProvider");
  }
  return context;
}

export const NetworkProvider = ({
  children,
  api,
}: {
  children?: React.ReactNode;
  api: NetworkAPIBase;
}) => {
  return (
    <NetworkContext.Provider value={{ api }}>
      {children}
    </NetworkContext.Provider>
  );
};
