import { render, type RenderOptions } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import en from "../../messages/en.json";
import ru from "../../messages/ru.json";

export const messages = { en, ru } as const;
export type TestLocale = keyof typeof messages;

export function IntlProvider({
  locale = "ru",
  children,
}: {
  locale?: TestLocale;
  children: ReactNode;
}) {
  return (
    <NextIntlClientProvider locale={locale} messages={messages[locale]}>
      {children}
    </NextIntlClientProvider>
  );
}

export function renderWithIntl(
  ui: ReactElement,
  { locale = "ru", ...options }: RenderOptions & { locale?: TestLocale } = {},
) {
  return render(ui, {
    ...options,
    wrapper: ({ children }) => (
      <IntlProvider locale={locale}>{children}</IntlProvider>
    ),
  });
}
