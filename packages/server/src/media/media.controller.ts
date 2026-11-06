import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOkResponse } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { MediaUploadResponse } from '@wired-io/shared';
import { Public, UseAuthGuard } from 'src/auth/auth-policy';
import { serveStaticAsset } from 'src/common/static-assets';
import { MAX_MEDIA_FILE_SIZE } from './media.constants';
import { MediaStorageService } from './media-storage.service';

@Controller('media')
export class MediaController {
  constructor(private readonly storage: MediaStorageService) {}

  @UseAuthGuard()
  @ApiBearerAuth()
  @Post()
  @HttpCode(201)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiOkResponse({ description: 'Stored image URL' })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_MEDIA_FILE_SIZE } }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File,
  ): Promise<MediaUploadResponse> {
    if (!file || !file.buffer) {
      throw new BadRequestException('Image file body is required');
    }
    const saved = await this.storage.saveImage(file.buffer);
    return { url: saved.url };
  }

  @Public()
  @Get(':filename')
  @ApiOkResponse({ description: 'Image bytes' })
  get(
    @Param('filename') filename: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile | undefined> {
    return serveStaticAsset(this.storage.uploadsRoot, filename, req, res, {
      crossOriginIsolation: true,
    });
  }
}
