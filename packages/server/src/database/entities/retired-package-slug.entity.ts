import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity('retired_package_slug')
export class RetiredPackageSlug {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  slug: string;

  @Column({ type: 'int' })
  packageId: number;

  @CreateDateColumn()
  retiredAt: Date;
}
