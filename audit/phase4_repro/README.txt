Read-only reproductions behind PRODUCT_IDENTITY_AUDIT.txt. They import the app's real matching / pricing / gate code and run it on in-memory text
or on a throw-away database in the OS temp folder. They never open your real database, config or browser profiles, and make no network calls.

  node audit/phase4_repro/build.cjs repro1 && node audit/phase4_repro/repro1.cjs   name matching, identity pre-check, comp gate across many categories
  node audit/phase4_repro/build.cjs repro2 && node audit/phase4_repro/repro2.cjs   the reported Xbox 360 controller through lookup, pricing and the Deal Quality Gate
  node audit/phase4_repro/build.cjs repro3 && node audit/phase4_repro/repro3.cjs   which entry wins when a generic and a specific entry both exist

The generated .cjs files can be deleted. This folder is not part of the app build.
