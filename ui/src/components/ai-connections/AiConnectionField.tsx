import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  aiConnectionBindingSchema,
  isAiConnectionCompatible,
  type AiConnectionBinding,
  type AiAuthMethod,
  type AiProvider,
} from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { AiConnectionPicker } from "./AiConnectionPicker";
import { AiConnectionLegacyNotice } from "./AiConnectionManagement";
import { AiConnectionCredentialStep } from "./AiConnectionCredentialStep";
import { Button } from "@/components/ui/button";
import { RadioCardGroup } from "@/components/ui/radio-card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export function aiProviderForAdapter(
  adapterType: string,
): AiProvider | undefined {
  return (
    {
      claude_local: "anthropic",
      codex_local: "openai",
      opencode_local: "openrouter",
      grok_local: "xai",
    } as Record<string, AiProvider>
  )[adapterType];
}
export function AiConnectionField({
  companyId,
  agentId,
  agentName,
  adapterType,
  model,
  value,
  onChange,
  environmentId,
  legacy = false,
  readOnly = false,
}: {
  companyId: string;
  agentId?: string;
  agentName: string;
  adapterType: string;
  model?: string;
  value?: AiConnectionBinding;
  onChange: (binding: AiConnectionBinding) => void;
  environmentId?: string;
  legacy?: boolean;
  readOnly?: boolean;
}) {
  const provider = aiProviderForAdapter(adapterType);
  const returnFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = (event: Event) => { event.preventDefault(); returnFocus.current?.focus(); };
  const [adopting, setAdopting] = useState(false);
  const [pendingAdoption, setPendingAdoption] = useState<AiConnectionBinding>();
  const [connecting, setConnecting] = useState(false);
  // Ownership is chosen per sign-in rather than remembered: a manager creating
  // a company credential once should not silently make their next personal
  // login shared too.
  const [ownership, setOwnership] = useState<"personal" | "shared">("personal");
  const changeBinding = (next: AiConnectionBinding) => {
    if (legacy && !value) { if (!connecting) returnFocus.current = document.activeElement as HTMLElement; setPendingAdoption(next); }
    else onChange(next);
  };
  const client = useQueryClient();
  const accounts = useQuery({
    queryKey: ["ai-connections", companyId, agentId],
    queryFn: () => aiConnectionsApi.list(companyId, agentId),
    enabled: Boolean(provider),
  });
  // Server-decided, never inferred here: `tools:manage_connections` is not in
  // any payload the client already holds, and the create route rejects a
  // shared ownership without it.
  const canShareConnections = accounts.data?.canShareConnections ?? false;
  const method: AiAuthMethod = (value?.mode !== "responsible_user" ? value?.method : undefined)
    ?? accounts.data?.connections.find((account) => account.provider === provider && account.isDefault)?.method
    ?? (provider === "openrouter" ? "api_key" : "subscription");
  if (!provider) return null;
  if (legacy && !value && !adopting)
    return (
      <AiConnectionLegacyNotice
        readOnly={readOnly}
        onAdopt={() => setAdopting(true)}
      />
    );
  return (
    <div className="space-y-4">
      {value && (adapterType !== "opencode_local" || Boolean(model)) && !isAiConnectionCompatible(value, adapterType, model) && (
        <p role="alert" className="text-sm text-destructive">
          This connection does not support the current harness and model. Choose
          a compatible connection before saving.
        </p>
      )}
      <AiConnectionPicker
        requirement={{ companyId, provider }}
        connections={accounts.data?.connections ?? []}
        value={value}
        currentUserId={accounts.data?.currentUserId ?? ""}
        agentId={agentId ?? ""}
        agentName={agentName}
        readOnly={readOnly}
        loading={accounts.isPending}
        error={accounts.error?.message}
        onChange={(binding) =>
          changeBinding(aiConnectionBindingSchema.parse(binding))
        }
        onConnect={() => { returnFocus.current = document.activeElement as HTMLElement; setConnecting(true); }}
        onRetry={() => void accounts.refetch()}
      />
      <Dialog
        open={Boolean(pendingAdoption)}
        onOpenChange={(open) => {
          if (!open) setPendingAdoption(undefined);
        }}
      >
        <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl" onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>Adopt Connections for {agentName}</DialogTitle>
            <DialogDescription>
              Saving tests this account in {agentName}’s environment before
              replacing its existing authentication. Other agents keep their
              current configuration.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm">
            {pendingAdoption?.mode === "responsible_user"
              ? `Responsible user’s default. For you: ${accounts.data?.connections.find((account) => account.isDefault && account.provider === provider)?.name ?? "Not connected"}. Other users use their own default.`
              : accounts.data?.connections.find(
                  (account) => account.id === pendingAdoption?.connectionId,
                )?.name}
          </p>
          <p className="text-xs text-muted-foreground">
            After adoption, missing credentials block execution. Previous
            authentication will not be used as a fallback.
          </p>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPendingAdoption(undefined)}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (pendingAdoption) onChange(pendingAdoption);
                setPendingAdoption(undefined);
              }}
            >
              Use this binding when saved
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={connecting}
        onOpenChange={(open) => {
          if (!open) setOwnership("personal");
          setConnecting(open);
        }}
      >
        <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl" onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>Connect account</DialogTitle>
          </DialogHeader>
          {canShareConnections && (
            <section className="space-y-2" aria-label="Who owns this account">
              <h3 className="text-sm font-semibold">Who owns this account?</h3>
              <RadioCardGroup
                ariaLabel="Who owns this account"
                className="sm:grid-cols-2"
                value={ownership}
                onValueChange={(value) =>
                  setOwnership(value === "shared" ? "shared" : "personal")
                }
                options={[
                  {
                    value: "personal",
                    title: "Personal",
                    description:
                      "Yours. Runs use your seat, and it leaves with you.",
                  },
                  {
                    value: "shared",
                    title: "Company shared",
                    description:
                      "The organization owns it and it outlives your account.",
                  },
                ]}
              />
            </section>
          )}
          <AiConnectionCredentialStep
            companyId={companyId}
            provider={provider}
            initialMethod={method}
            name={`My ${provider === "anthropic" ? "Claude" : provider === "openai" ? "OpenAI" : provider === "xai" ? "Grok" : "OpenRouter"} ${method === "subscription" ? "subscription" : "API"}`}
            ownership={ownership}
            agentIds={agentId ? [agentId] : []}
            allAgents={false}
            environmentId={environmentId}
            onCancel={() => setConnecting(false)}
            onComplete={() => {
              void client.invalidateQueries({
                queryKey: ["ai-connections", companyId],
              });
              setConnecting(false);
              changeBinding({ provider, method, mode: "responsible_user" });
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
