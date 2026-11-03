import { useTranslations } from "next-intl";
import { useCallback } from "react";
import type en from "../../messages/en.json";

type NestedKeyOf<T> = {
  [K in keyof T & string]: T[K] extends string
    ? K
    : `${K}.${NestedKeyOf<T[K]>}`;
}[keyof T & string];

export type MessageKey = NestedKeyOf<typeof en>;
export type AppMessage = {
  key: MessageKey;
  values?: Record<string, string | number>;
};

export function useAppMessage() {
  const t = useTranslations();
  return useCallback(
    (message: AppMessage) => t(message.key, message.values),
    [t],
  );
}
