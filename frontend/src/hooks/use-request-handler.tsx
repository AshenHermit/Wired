"use client";

import React from "react";
import { toast } from "sonner";

export function useRequestHandler({
  toastOnError = true,
}: { toastOnError?: boolean } = {}) {
  const [loading, setLoading] = React.useState<boolean>(false);
  const [error, setError] = React.useState<string | null>(null);
  const handleRequest = React.useCallback(
    async (requestFunc: () => Promise<void>) => {
      setLoading(true);
      setError(null);
      try {
        await requestFunc();
      } catch (e) {
        if (e instanceof Error) {
          e.message;
          setError(e.message);
          if (toastOnError) {
            toast.error(e.message);
          }
        }
      }
      setLoading(false);
    },
    [toastOnError]
  );
  return { loading, error, handleRequest };
}
