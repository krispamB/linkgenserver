import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { ConnectedAccount } from './connected-account.schema';
import { User } from './user.schema';

export enum PostStatus {
  SCHEDULED = 'SCHEDULED',
  PUBLISHED = 'PUBLISHED',
  FAILED = 'FAILED',
}

@Schema({ _id: false })
export class PostArtifactReference {
  @Prop({ type: Types.ObjectId, ref: 'Artifact', required: true })
  artifact: Types.ObjectId;

  @Prop({ required: true, min: 1 })
  version: number;
}

export const PostArtifactReferenceSchema = SchemaFactory.createForClass(
  PostArtifactReference,
);

@Schema({ timestamps: true })
export class Post extends Document {
  @Prop({ type: Types.ObjectId, ref: User.name, required: true })
  user: User | Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: ConnectedAccount.name, required: true })
  connectedAccount: ConnectedAccount | Types.ObjectId;

  @Prop({ type: [PostArtifactReferenceSchema], required: true })
  artifacts: PostArtifactReference[];

  @Prop({ required: true, enum: PostStatus })
  status: PostStatus;

  @Prop()
  scheduledAt?: Date;

  @Prop()
  publishedAt?: Date;

  @Prop()
  channelPostId?: string;

  @Prop()
  failureReason?: string;
}

export const PostSchema = SchemaFactory.createForClass(Post);
