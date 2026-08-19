import { getAuthContextOrRedirect } from '@/server/common/page-auth';
import { StarredMessagesView } from '@/components/chat/starred-messages-view';

// Auth-gated the same way every other (app) page is; the actual starred-message
// resolution happens client-side (StarredMessagesView) since it needs this
// device's own local decrypted cache, which server components have no access to.
export default async function StarredPage() {
  await getAuthContextOrRedirect();
  return (
    <div className="h-full">
      <StarredMessagesView />
    </div>
  );
}
