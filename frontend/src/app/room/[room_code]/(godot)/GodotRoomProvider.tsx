"use client";

import React from "react";
import { GodotEditorApi } from "./GodotEditor";
import { GodotEditorInstance } from "./GodotEditorInstance";

export type GodotRoomContextType = {
  editorApi: GodotEditorApi;
  setEditorApi: (api: GodotEditorApi) => void;
};

export const GodotRoomContext = React.createContext<GodotRoomContextType>({
  editorApi: {
    editorRef: React.createRef<GodotEditorInstance>(),
  },
  setEditorApi: () => {},
});

export function GodotRoomProvider({ children }: { children: React.ReactNode }) {
  const [editorApi, setEditorApi] = React.useState<GodotEditorApi>({
    editorRef: React.createRef<GodotEditorInstance>(),
  });
  const ctxValue: GodotRoomContextType = {
    editorApi,
    setEditorApi,
  };
  return (
    <GodotRoomContext.Provider value={ctxValue}>
      {children}
    </GodotRoomContext.Provider>
  );
}

export function useGodotRoomContext() {
  return React.useContext(GodotRoomContext);
}
