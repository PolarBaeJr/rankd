# Project-specific R8 rules. None yet: kotlinx.serialization ships its own
# consumer rules, and the release build is where a missing one would show.
# Credential Manager loads CredentialProviderPlayServicesImpl by reflection,
# from a manifest meta-data string; credentials-play-services-auth ships the
# keep rule for it. Check it survives with
# `apkanalyzer dex packages --defined-only` on the release APK.
