# Release, and the thing that actually gets harder

Today a deploy is: push, CI builds, the hosts pull, and every user is on the new
version within minutes. Nobody is running an old client. Every assumption in this
repository rests on that quietly.

App stores end it. Review latency is measured in days, and users update whenever they
feel like it. Somebody will be running the February build in October. With both an
Android and an iOS app there are two stores, two review queues and two populations
of old builds, and the two apps will not ship on the same day.

Two consequences, both of which are ongoing costs rather than one time work:

1. **Every migration has to stay compatible with shipped app versions.** A column
   rename that is trivial on the web becomes a breaking change for phones in the
   wild. This repository ships migrations often, so this is the real recurring tax,
   more than writing the screens.

2. **The app needs a minimum version gate.** A server side value the app checks on
   launch, so a build too old to be safe can be told to update instead of failing in
   confusing ways. Decide where it lives before shipping version 1. Note that
   `platform_settings` and `cron_config` are cloned wholesale by the nightly
   production to staging snapshot, so anything host specific belongs in an
   environment variable instead.

Neither is a reason not to do it. Both are reasons to decide them at the start rather
than discovering them at the first breaking migration.
