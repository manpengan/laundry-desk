import Foundation

enum RuntimeDatabaseImportAuthority {
  static let role = "laundry_restore"

  static var resetSQL: String {
    """
    \(cleanupSQL)
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public AUTHORIZATION pg_database_owner;
    GRANT USAGE ON SCHEMA public TO PUBLIC;
    COMMENT ON SCHEMA public IS 'standard public schema';
    """
  }

  static var prepareSQL: String {
    let tables = RuntimeDatabaseImportSchema.loadOrder.map { "public.\($0)" }.joined(
      separator: ", ")
    let sequences = RuntimeDatabaseImportSchema.sequences.map { "public.\($0)" }.joined(
      separator: ", ")
    let policies = RuntimeDatabaseImportSchema.rlsTables
      .map {
        "CREATE POLICY runtime_restore_insert ON public.\($0) FOR INSERT TO \(role) WITH CHECK (true);"
      }
      .joined(separator: "\n")
    return """
      BEGIN;
      CREATE ROLE \(role) LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1;
      GRANT CONNECT, TEMPORARY ON DATABASE laundry_v2 TO \(role);
      GRANT USAGE ON SCHEMA public TO \(role);
      GRANT SELECT, INSERT ON TABLE \(tables) TO \(role);
      GRANT USAGE, SELECT, UPDATE ON SEQUENCE \(sequences) TO \(role);
      \(policies)
      COMMIT;
      """
  }

  static var cleanupSQL: String {
    """
    DO $cleanup$
    DECLARE target record;
    BEGIN
      FOR target IN
        SELECT n.nspname, c.relname
        FROM pg_catalog.pg_policy p
        JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND p.polname = 'runtime_restore_insert'
      LOOP
        EXECUTE pg_catalog.format(
          'DROP POLICY IF EXISTS runtime_restore_insert ON %I.%I',
          target.nspname, target.relname);
      END LOOP;
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '\(role)') THEN
        EXECUTE 'DROP OWNED BY \(role)';
        EXECUTE 'DROP ROLE \(role)';
      END IF;
    END
    $cleanup$;
    COMMENT ON SCHEMA public IS 'standard public schema';
    """
  }

  static var verificationSQL: String {
    let expected = RuntimeDatabaseImportSchema.rlsTables.count
    return """
      DO $$ DECLARE invalid_count integer; BEGIN
        SELECT count(*) INTO invalid_count
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname IN (\(rlsNamesSQL))
          AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);
        IF invalid_count <> 0 THEN RAISE EXCEPTION 'runtime restore RLS verification failed'; END IF;
        IF (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname IN (\(rlsNamesSQL))) <> \(expected) THEN
          RAISE EXCEPTION 'runtime restore table verification failed';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '\(role)') OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_policy p
          JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND p.polname = 'runtime_restore_insert'
        ) THEN
          RAISE EXCEPTION 'runtime restore authority cleanup failed';
        END IF;
        IF pg_catalog.obj_description('public'::pg_catalog.regnamespace)
          IS DISTINCT FROM 'standard public schema' THEN
          RAISE EXCEPTION 'runtime restore schema comment cleanup failed';
        END IF;
      END $$;
      """
  }

  private static var rlsNamesSQL: String {
    RuntimeDatabaseImportSchema.rlsTables.map { "'\($0)'" }.joined(separator: ", ")
  }
}
