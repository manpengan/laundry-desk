import Foundation

enum RuntimeBackupCommands {
  private static let photoRoot = "/photos"
  private static let validatePhotoScript =
    #"const fs=require('node:fs');const p='/photos',owner=10001,mode=s=>s.mode&0o777,same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;const root=fs.lstatSync(p);if(!root.isDirectory()||root.uid!==owner||root.gid!==owner||mode(root)!==0o700)process.exit(20);const ns=fs.readdirSync(p);if(ns.length>100001)process.exit(21);let marker=false,total=0;const ok=/^(?:\.laundry-photo-store-v1|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp))$/u;for(const n of ns){if(!ok.test(n))process.exit(22);const q=p+'/'+n,fd=fs.openSync(q,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const a=fs.fstatSync(fd),b=fs.lstatSync(q);if(!a.isFile()||a.nlink!==1||a.uid!==owner||a.gid!==owner||mode(a)!==0o600||!same(a,b)||a.size<1||a.size>20971520)process.exit(23);total+=a.size;if(total>137438953472)process.exit(24);if(n==='.laundry-photo-store-v1')marker=true;}finally{fs.closeSync(fd);}}if(!marker)process.exit(25);"#
  private static let clearPhotoScript =
    #"const fs=require('node:fs');const p='/photos';for(const n of fs.readdirSync(p)){fs.rmSync(p+'/'+n,{recursive:true,force:false,maxRetries:0});}"#
  private static let photoInventoryScript =
    #"const fs=require('node:fs'),crypto=require('node:crypto');const p='/photos',owner=10001,mode=s=>s.mode&0o777,same=(a,b)=>a.dev===b.dev&&a.ino===b.ino,ok=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/u;try{const root=fs.lstatSync(p);if(!root.isDirectory()||root.uid!==owner||root.gid!==owner||mode(root)!==0o700)process.exit(20);const ns=fs.readdirSync(p).sort();if(ns.length>100001)process.exit(21);let marker=false,total=0;const rows=[];for(const n of ns){if(n!=='.laundry-photo-store-v1'&&!ok.test(n))process.exit(22);const q=p+'/'+n,fd=fs.openSync(q,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const a=fs.fstatSync(fd),b=fs.lstatSync(q);if(!a.isFile()||a.nlink!==1||a.uid!==owner||a.gid!==owner||mode(a)!==0o600||!same(a,b)||a.size<1||a.size>20971520)process.exit(23);const bytes=fs.readFileSync(fd),c=fs.fstatSync(fd),d=fs.lstatSync(q);if(!same(a,c)||!same(c,d)||a.size!==c.size)process.exit(23);total+=a.size;if(total>137438953472)process.exit(24);if(n==='.laundry-photo-store-v1'){if(!bytes.equals(Buffer.from('laundry-desk-photo-store:v1\n')))process.exit(25);marker=true;}else{rows.push({byte_size:a.size,content_sha256:crypto.createHash('sha256').update(bytes).digest('hex'),storage_key:n});}}finally{fs.closeSync(fd);}}if(!marker)process.exit(25);process.stdout.write(JSON.stringify(rows));}catch{process.exit(26);}"#
  private static let databasePhotoInventorySQL =
    """
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'byte_size', byte_size,
          'content_sha256', content_sha256,
          'storage_key', storage_key
        ) ORDER BY storage_key
      ),
      '[]'::jsonb
    )::text
    FROM public.garment_photos;
    """

  private static func container(
    controller: NativeRuntimeController, image: String, writable: Bool,
    interactive: Bool = false, entrypoint: String, arguments: [String]
  ) -> [String] {
    [
      "run", "--rm",
    ] + (interactive ? ["--interactive"] : []) + [
      "--network", "none", "--read-only",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", "64", "--user", "10001:10001",
      "--mount",
      "type=volume,source=\(controller.photoVolumeName),target=/photos"
        + (writable ? "" : ",readonly"),
      "--entrypoint", entrypoint, controller.runtimeServerImage(image),
    ] + arguments
  }

  private static func databaseParser(image: String, arguments: [String]) -> [String] {
    [
      "run", "--rm", "--interactive", "--network", "none", "--read-only",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", "64", "--memory", "536870912", "--memory-swap", "536870912",
      "--user", "65534:65534",
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=0700,uid=65534,gid=65534",
      "--entrypoint", "/usr/bin/pg_restore", image,
    ] + arguments
  }

  static func validatePhotos(
    controller: NativeRuntimeController, image: String
  ) -> RuntimeCommandSpec {
    controller.command(
      container(
        controller: controller, image: image, writable: false,
        entrypoint: "/usr/local/bin/node",
        arguments: ["-e", validatePhotoScript]))
  }

  static func photoInventory(
    controller: NativeRuntimeController, image: String
  ) -> RuntimeCommandSpec {
    controller.command(
      container(
        controller: controller, image: image, writable: false,
        entrypoint: "/usr/local/bin/node",
        arguments: ["-e", photoInventoryScript]))
  }

  static func clearPhotos(
    controller: NativeRuntimeController, image: String
  ) -> RuntimeCommandSpec {
    controller.command(
      container(
        controller: controller, image: image, writable: true,
        entrypoint: "/usr/local/bin/node",
        arguments: ["-e", clearPhotoScript]))
  }

  static func archivePhotos(
    controller: NativeRuntimeController, image: String
  ) -> RuntimeCommandSpec {
    controller.command(
      container(
        controller: controller, image: image, writable: false, entrypoint: "/bin/tar",
        arguments: [
          "--create", "--file=-", "--directory=\(photoRoot)", "--format=posix",
          "--sort=name", "--one-file-system", ".",
        ]))
  }

  static func inspectPhotoArchive(
    controller: NativeRuntimeController, image: String
  ) -> RuntimeCommandSpec {
    controller.command(
      container(
        controller: controller, image: image, writable: false, interactive: true,
        entrypoint: "/bin/tar",
        arguments: ["--list", "--file=-"]))
  }

  static func restorePhotos(
    controller: NativeRuntimeController, image: String
  ) -> RuntimeCommandSpec {
    controller.command(
      container(
        controller: controller, image: image, writable: true, interactive: true,
        entrypoint: "/bin/tar",
        arguments: [
          "--extract", "--file=-", "--directory=\(photoRoot)", "--no-same-owner",
          "--no-same-permissions", "--no-overwrite-dir", "--mode=0600",
          "--delay-directory-restore",
        ]))
  }

  static func dumpDatabase(
    controller: NativeRuntimeController, environment: [String: String]
  ) -> RuntimeCommandSpec {
    controller.compose(
      [
        "exec", "-T", "--user", "postgres", "postgres", "pg_dump",
        "--format=custom", "--no-owner", "--no-privileges", "--dbname=laundry_v2",
      ], environment: environment)
  }

  static func databaseCapacity(
    controller: NativeRuntimeController, environment: [String: String]
  ) -> RuntimeCommandSpec {
    controller.compose(
      [
        "exec", "-T", "--user", "postgres", "postgres", "/bin/df", "-Pk",
        "/var/lib/postgresql/data",
      ], environment: environment)
  }

  static func databasePhotoInventory(
    controller: NativeRuntimeController, environment: [String: String]
  ) -> RuntimeCommandSpec {
    controller.compose(
      [
        "exec", "-T", "--user", "postgres", "postgres", "psql",
        "--username=postgres", "--dbname=laundry_v2", "--no-psqlrc",
        "--set=ON_ERROR_STOP=1", "--tuples-only", "--no-align", "--quiet",
        "--command", databasePhotoInventorySQL,
      ], environment: environment)
  }

  static func listDatabaseDump(
    controller: NativeRuntimeController, image: String
  ) -> RuntimeCommandSpec {
    controller.command(databaseParser(image: image, arguments: ["--list", "--file=-"]))
  }

  static func extractDatabaseData(
    controller: NativeRuntimeController, image: String
  ) -> RuntimeCommandSpec {
    controller.command(
      databaseParser(
        image: image,
        arguments: ["--data-only", "--no-owner", "--no-privileges", "--file=-"]))
  }

  private static func databaseAdmin(
    controller: NativeRuntimeController, environment: [String: String], sql: String
  ) -> RuntimeCommandSpec {
    controller.compose(
      [
        "exec", "-T", "--user", "postgres", "postgres", "psql",
        "--username=postgres", "--dbname=laundry_v2", "--no-psqlrc",
        "--set=ON_ERROR_STOP=1", "--command", sql,
      ], environment: environment)
  }

  static func resetDatabase(
    controller: NativeRuntimeController, environment: [String: String]
  ) -> RuntimeCommandSpec {
    databaseAdmin(
      controller: controller, environment: environment,
      sql: RuntimeDatabaseImportAuthority.resetSQL)
  }

  static func prepareDatabaseImport(
    controller: NativeRuntimeController, environment: [String: String]
  ) -> RuntimeCommandSpec {
    databaseAdmin(
      controller: controller, environment: environment,
      sql: RuntimeDatabaseImportAuthority.prepareSQL)
  }

  static func cleanupDatabaseImport(
    controller: NativeRuntimeController, environment: [String: String]
  ) -> RuntimeCommandSpec {
    databaseAdmin(
      controller: controller, environment: environment,
      sql: RuntimeDatabaseImportAuthority.cleanupSQL)
  }

  static func verifyDatabaseImportAuthority(
    controller: NativeRuntimeController, environment: [String: String]
  ) -> RuntimeCommandSpec {
    databaseAdmin(
      controller: controller, environment: environment,
      sql: RuntimeDatabaseImportAuthority.verificationSQL)
  }

  static func loadSanitizedDatabase(
    controller: NativeRuntimeController, environment: [String: String]
  ) -> RuntimeCommandSpec {
    controller.compose(
      [
        "exec", "-T", "--user", "postgres", "postgres", "psql",
        "--username=\(RuntimeDatabaseImportAuthority.role)", "--dbname=laundry_v2",
        "--no-psqlrc", "--set=ON_ERROR_STOP=1",
      ], environment: environment)
  }
}
