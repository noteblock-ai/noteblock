package org.harborapps.quire.app

import org.harborapps.quire.R

/**
 * The product's public name: app_name in res/values/strings.xml, which
 * scripts/build-mobile-host.mjs checks against BRAND.name in core/brand.mjs. Internal
 * identifiers (package, application id, the quire scheme, type names) stay "quire" on purpose.
 */
object Brand {
    val name: String get() = QuireApp.instance.getString(R.string.app_name)
}
