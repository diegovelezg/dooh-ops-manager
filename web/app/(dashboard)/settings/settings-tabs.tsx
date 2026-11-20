"use client";

import type { ReactNode } from "react";
import { Tabs } from "@base-ui/react/tabs";

export interface SettingsTab {
  id: string;
  label: string;
  content: ReactNode;
}

/** Tabs de Ajustes. Los paneles (server components) llegan ya renderizados. */
export function SettingsTabs({ tabs }: { tabs: SettingsTab[] }) {
  return (
    <Tabs.Root defaultValue={tabs[0]?.id} className="flex flex-col gap-6">
      <Tabs.List className="flex gap-1 border-b">
        {tabs.map((t) => (
          <Tabs.Tab
            key={t.id}
            value={t.id}
            className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[selected]:border-primary data-[selected]:text-foreground"
          >
            {t.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {tabs.map((t) => (
        <Tabs.Panel key={t.id} value={t.id} className="flex flex-col gap-8 outline-none">
          {t.content}
        </Tabs.Panel>
      ))}
    </Tabs.Root>
  );
}
