"use client";

import { useTranslations } from "next-intl";
import React from "react";
import { toast } from "sonner";
import { toAppMessage } from "@/i18n/api-error";
import type { AppMessage } from "@/i18n/message";

export type HandleRequestOptions = {
  errorMessage?: AppMessage;
};

export function useRequestHandler({
  toastOnError = true,
}: { toastOnError?: boolean } = {}) {
  const t = useTranslations();
  const [loading, setLoading] = React.useState<boolean>(false);
  const [error, setError] = React.useState<AppMessage | null>(null);
  const mounted = React.useRef(true);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const handleRequest = React.useCallback(
    async (
      requestFunc: () => Promise<void>,
      options?: HandleRequestOptions
    ): Promise<boolean> => {
      setLoading(true);
      setError(null);
      try {
        await requestFunc();
        return true;
      } catch (cause) {
        const message = options?.errorMessage ?? toAppMessage(cause);
        if (mounted.current) {
          setError(message);
          if (toastOnError) {
            toast.error(t(message.key, message.values));
          }
        }
        return false;
      } finally {
        if (mounted.current) {
          setLoading(false);
        }
      }
    },
    [t, toastOnError]
  );
  return { loading, error, handleRequest };
}
