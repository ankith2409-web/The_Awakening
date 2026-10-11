/*
 * The service worker.
 *
 * Its entire job is to receive a push and show a notification. That is all.
 *
 * There is deliberately NO `fetch` handler, and that omission is the most important
 * decision in this file.
 *
 * A service worker with a fetch handler is a proxy in front of every request the page
 * makes, and the safe versions of one are subtle: a cache-first rule for an asset that
 * gets rebuilt, a network-first rule that falls through to a stale copy when the venue
 * wifi drops, a navigation preload that answers from cache before the server has been
 * consulted. Any of those would serve yesterday's bundle during a live event, and the
 * failure would look like "the portal is a bit broken" rather than "the service worker
 * is caching". Not intercepting anything makes that entire class of failure
 * unreachable: the app talks to the network exactly as it would without this file.
 *
 * It also has no `install` or `activate` handler doing real work, so a new version of
 * this file replaces the old one the moment it is deployed with no cache to invalidate.
 *
 * Scope: served from `/`, so it covers the whole origin. A worker served from
 * `/sw.js` is the only kind that can receive a push for a page at any path.
 */

/*
 * Chrome will not show a notification without an icon, and will not render one from a
 * bare path on some platforms. Using the site's own mark keeps a notification looking
 * like part of this event rather than like an unidentified system alert.
 */
const ICON = '/icons.svg'
const BADGE = '/favicon.svg'

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    /*
      A payload we cannot parse is still worth showing.

      Falling back to a generic body beats dropping the notification: somebody in a
      queue needs to know SOMETHING was sent, and a blank notification tells them
      nothing at all.
    */
    payload = {}
  }

  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'The Awakening'

  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof payload.body === 'string' ? payload.body : '',
      icon: ICON,
      badge: BADGE,
      /*
        `tag` collapses rather than stacks.

        If the owner sends "lunch is being served" and then "lunch is now in the main
        hall", the attendee should have one notification that says the second thing,
        not two they have to reconcile. Without a tag every message stacks and the
        phone becomes a stack of stale instructions nobody reads to the bottom of.
      */
      tag: 'awakening',
      /*
        Not `requireInteraction`.

        A notification that stays on screen until dismissed is right for a fire
        alarm and wrong for an event: this is information, and it is still on the
        lock screen for hours. Default behaviour expires it and it is still in
        notification history.
      */
      renotify: true,
      data: { url: typeof payload.url === 'string' ? payload.url : '/' },
    }),
  )
})

/*
 * Tapping a notification should land on the dashboard, which is where the pass is and
 * where the announcement is also shown.
 *
 * Reusing an already-open tab rather than opening a second one, because an attendee
 * with the portal open on their phone who taps the notification should end up looking
 * at that same tab — not with two copies of the portal and no idea which one is live.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const target = new URL(event.notification.data?.url ?? '/', self.location.origin).href

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })

      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus()
          if ('navigate' in client && client.url !== target) {
            await client.navigate(target).catch(() => undefined)
          }
          return
        }
      }

      await self.clients.openWindow(target)
    })(),
  )
})