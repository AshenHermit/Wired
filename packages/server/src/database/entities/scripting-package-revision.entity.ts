import { ApiProperty } from '@nestjs/swagger';
import { PackageFileEntry, PackageRevisionStatus } from '@wired-io/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ScriptingPackage } from './scripting-package.entity';

/**
 * One immutable content revision of a scripting package.
 *
 * A row is created as `draft` while files are uploaded, and becomes
 * `published` only after every declared file was verified on disk. Published
 * rows are never reused: a new publication allocates a new revision number.
 */
@Entity()
@Index(['package', 'revision'], { unique: true })
export class ScriptingPackageRevision {
  @ApiProperty({ example: 1, description: 'Unique revision row ID' })
  @PrimaryGeneratedColumn()
  id: number;

  @ApiProperty({ description: 'Owning package', type: () => ScriptingPackage })
  @ManyToOne(() => ScriptingPackage, { onDelete: 'CASCADE' })
  package: ScriptingPackage;

  @ApiProperty({ example: 1, description: 'Monotonic revision number' })
  @Column({ type: 'int' })
  revision: number;

  @ApiProperty({ example: 'published', description: 'draft or published' })
  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status: PackageRevisionStatus;

  @ApiProperty({ description: 'Declared package files with hashes' })
  @Column({ type: 'jsonb', default: [] })
  files: PackageFileEntry[];

  @ApiProperty({ description: 'date revision created at' })
  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  createdAt: Date;

  @ApiProperty({ description: 'date revision published at', nullable: true })
  @Column({ type: 'timestamp', nullable: true, default: null })
  publishedAt: Date | null;
}
