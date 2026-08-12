/** Set while a modal overlay (help / global fuzzy search) is open. Screens
 *  check this first in their useKeyboard handler so keys don't leak through
 *  the overlay — OpenTUI invokes child handlers before parent handlers, so a
 *  screen can't rely on App stopping propagation.
 */
export const overlayOpen: { current: boolean } = { current: false }
