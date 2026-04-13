#pragma once

class FileDescriptor {
public:
  FileDescriptor();
  explicit FileDescriptor(int fd);
  ~FileDescriptor();

  FileDescriptor(const FileDescriptor&) = delete;
  FileDescriptor& operator=(const FileDescriptor&) = delete;

  FileDescriptor(FileDescriptor&& other) noexcept;
  FileDescriptor& operator=(FileDescriptor&& other) noexcept;

  int get() const;
  int release();
  bool is_valid() const;
  void reset(int fd = -1);

private:
  int fd_;
};
