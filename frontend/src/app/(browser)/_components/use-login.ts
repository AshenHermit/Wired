"use client";

import { BACKEND_URL } from "@/utils/variables";
import { useRouter } from "next/navigation";
import React from "react";

export type ServicesCode = "google";

const endpoints: Record<ServicesCode, string> = {
  google: BACKEND_URL + "/auth/google",
};

export function useServiceAuthorization(serviceCode: ServicesCode) {
  const router = useRouter();
  const auth = React.useCallback(() => {
    const endpoint = endpoints[serviceCode];
    router.push(endpoint);
  }, [router, serviceCode]);
  return auth;
}
