import DMSwitcher from "@/components/DMSwitcher";
import DMThread from "@/components/DMThread";
import { useDMStore } from "@/store/dm.store";

/**
 * Private conversations, at the same level as the channels.
 *
 * They were reached through a button inside the channel panel, which put
 * "message a person" two screens deep behind "read a channel" and was why
 * nobody could find them. Two people talking is not a mode of a channel.
 */
export default function DirectMessages() {
  const abierta = useDMStore((s) => s.conversationId);

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-60 shrink-0 flex-col border-r bg-muted/10">
        <header className="flex h-12 shrink-0 items-center border-b px-3">
          <span className="text-sm font-medium">Direct messages</span>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <DMSwitcher onPicked={() => {}} />
        </div>
      </aside>
      {abierta ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <DMThread onBack={() => useDMStore.setState({ conversationId: null, messages: [] })} />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Pick somebody to write to.
        </div>
      )}
    </div>
  );
}
