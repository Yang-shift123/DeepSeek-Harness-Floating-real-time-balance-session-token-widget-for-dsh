/**
 * Host half of the account usage widget bundle.
 *
 * The widget is a browser-side decoration: it reads the account through the
 * existing `account` Remote namespace and renders through the existing slot
 * registry, so the Host half owns no state, contributes no service and adds
 * nothing model-facing. It exists because a bundle's patch row must resolve to
 * a loadable module; the Client half declared by `dsh.client` does the work.
 */
export function apply() {}
