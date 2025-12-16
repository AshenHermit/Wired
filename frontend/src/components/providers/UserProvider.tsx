"use client";

import { useUserStore } from "@/store/user-store";
import React from "react";

export function UserProvider() {
  const loadUser = useUserStore((state) => state.loadUser);
  React.useEffect(() => {
    loadUser();
  }, [loadUser]);
  return null;
}
