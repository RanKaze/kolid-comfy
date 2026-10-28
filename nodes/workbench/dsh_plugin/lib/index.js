/**
 * Host half of kolid-dsh-bind — deliberately empty.
 *
 * The plugin is pure browser surface: the workbench picks the workspace and the client half does the
 * switching. The empty `apply` exists so the plugin appears in the host Loader tree, which is where
 * dsh's client-module scan finds a package's `dsh.client` declaration and ships its `./client` bundle
 * to the page (see @deepseek-ai/dsh-client-modules).
 */
export function apply() {}
