import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1788613051531 } from './migrations/1788613051531-CreateVideos';
import { AddPartCountToVideos1788615610636 } from './migrations/1788615610636-AddPartCountToVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
];

// Migrations 3+4 (videos) are NOT part of the device-under-test dataSource below —
// this suite deliberately exercises only the first two migrations' apply/revert
// behavior. They are used solely to restore the "videos" table in `afterAll`,
// since `videos` has a FK to `channels` and gets cascade-dropped by this suite's
// own cleanup (see beforeAll).
const VIDEO_MIGRATIONS = [
  CreateVideos1788613051531,
  AddPartCountToVideos1788615610636,
];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
        ],
      },
    );

    await dataSource.initialize();

    // "videos" FKs to "channels" — drop it first so the CASCADE below is scoped
    // to what this suite actually manages, and drop its enum type too so the
    // CreateVideos migration can recreate it cleanly during afterAll restoration.
    await dataSource.query('DROP TABLE IF EXISTS "videos" CASCADE');
    await dataSource.query(
      'DROP TYPE IF EXISTS "public"."videos_status_enum" CASCADE',
    );

    await Promise.all([
      ...MANAGED_TABLES.map((table) =>
        dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`),
      ),
      dataSource.query(`DROP TABLE IF EXISTS "migrations" CASCADE`),
    ]);

    // DROP TABLE never drops the custom enum type it used — without this, a
    // shared DB that already ran the real migrations once (e.g. via
    // `npm run migration:run` outside this suite) fails CreateAuthTokens.up()
    // with "type already exists" when this suite re-runs migrations from
    // scratch below.
    await dataSource.query(
      'DROP TYPE IF EXISTS "public"."verification_tokens_type_enum" CASCADE',
    );
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving token tables missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();

    // Restore "videos" (dropped in beforeAll) — this dataSource's own migrations
    // list never included it, so a separate one finishes the job.
    const videoDataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      { synchronize: false, migrations: VIDEO_MIGRATIONS },
    );
    await videoDataSource.initialize();
    await videoDataSource.runMigrations();
    await videoDataSource.destroy();
  });

  it('should apply all migrations and create all four tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(2);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
    ]);
  });

  it('should revert the last migration and remove token tables', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['refresh_tokens', 'verification_tokens']],
    );
    expect(result).toHaveLength(0);
  });
});
