from pydantic import BaseModel, Field


class UploadUrlResponse(BaseModel):
    uploadUrl: str = Field(..., description="Presigned S3 PUT URL, valid for 1 hour")
    fileUrl: str = Field(..., description="Where the file can be read after upload")
