"use client";

import React from "react";
import { toast } from "sonner";

export function useRequestHandler({
  toastOnError = true,
}: { toastOnError?: boolean } = {}) {
  const [loading, setLoading] = React.useState<boolean>(false);
  const [error, setError] = React.useState<string | null>(null);
  const mounted = React.useRef(true);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const handleRequest = React.useCallback(
    async (requestFunc: () => Promise<void>): Promise<boolean> => {
      setLoading(true);
      setError(null);
      try {
        await requestFunc();
        return true;
      } catch (e) {
        const message =
          e instanceof Error ? e.message : "Не удалось выполнить запрос";
        if (mounted.current) {
          setError(message);
          if (toastOnError) {
            toast.error(message);
          }
        }
        return false;
      } finally {
        if (mounted.current) {
          setLoading(false);
        }
      }
    },
    [toastOnError]
  );
  return { loading, error, handleRequest };
}
