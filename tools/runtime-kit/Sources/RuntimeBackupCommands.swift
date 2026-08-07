import Foundation

enum RuntimeBackupCommands {
  private static let photoRoot = "/photos"
  private static let photoMount =
    "type=volume,source=laundry-desk-runtime_photos,target=/photos"
  private static let validatePhotoScript =
    #"const fs=require('node:fs');const p='/photos';const ns=fs.readdirSync(p);if(ns.length>100001)process.exit(21);let marker=false,total=0;const ok=/^(?:\.laundry-photo-store-v1|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp))$/u;for(const n of ns){if(!ok.test(n))process.exit(22);const s=fs.lstatSync(p+'/'+n);if(!s.isFile()||s.nlink!==1||s.size<1||s.size>20971520)process.exit(23);total+=s.size;if(total>137438953472)process.exit(24);if(n==='.laundry-photo-store-v1')marker=true;}if(!marker)process.exit(25);"#
  private static let clearPhotoScript =
    #"const fs=require('node:fs');const p='/photos';for(const n of fs.readdirSync(p)){fs.rmSync(p+'/'+n,{recursive:true,force:false,maxRetries:0});}"#

  private static func container(
    image: String, writable: Bool, entrypoint: String, arguments: [String]
  ) -> [String] {
    [
      "run", "--rm", "--network", "none", "--read-only",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", "64", "--user", "10001:10001",
      "--mount", photoMount + (writable ? "" : ",readonly"),
      "--entrypoint", entrypoint, image,
    ] + arguments
  }

  static func validatePhotos(
    controller: NativeRuntimeController, image: String
  ) -> RuntimeCommandSpec {
    controller.command(
      container(
        image: image, writable: false, entrypoint: "/usr/local/bin/node",
        arguments: ["-e", validatePhotoScript]))
  }

  static func clearPhotos(
    controller: NativeRuntimeController, image: String
  ) -> RuntimeCommandSpec {
    controller.command(
      container(
        image: image, writable: true, entrypoint: "/usr/local/bin/node",
        arguments: ["-e", clearPhotoScript]))
  }

  static func archivePhotos(
    controller: NativeRuntimeController, image: String
  ) -> RuntimeCommandSpec {
    controller.command(
      container(
        image: image, writable: false, entrypoint: "/bin/tar",
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
        image: image, writable: false, entrypoint: "/bin/tar",
        arguments: ["--list", "--file=-"]))
  }

  static func restorePhotos(
    controller: NativeRuntimeController, image: String
  ) -> RuntimeCommandSpec {
    controller.command(
      container(
        image: image, writable: true, entrypoint: "/bin/tar",
        arguments: [
          "--extract", "--file=-", "--directory=\(photoRoot)", "--no-same-owner",
          "--no-same-permissions", "--delay-directory-restore",
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

  static func inspectDatabaseDump(
    controller: NativeRuntimeController, environment: [String: String]
  ) -> RuntimeCommandSpec {
    controller.compose(
      [
        "exec", "-T", "--user", "postgres", "postgres", "pg_restore",
        "--list", "--file=/dev/null",
      ], environment: environment)
  }

  static func restoreDatabase(
    controller: NativeRuntimeController, environment: [String: String]
  ) -> RuntimeCommandSpec {
    controller.compose(
      [
        "exec", "-T", "--user", "postgres", "postgres", "pg_restore",
        "--clean", "--if-exists", "--no-owner", "--no-privileges",
        "--single-transaction", "--exit-on-error", "--dbname=laundry_v2",
      ], environment: environment)
  }
}
