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

  [[nodiscard]] int get() const;
  int release();
  [[nodiscard]] bool is_valid() const;
  void reset(int fd = -1);

 private:
  int fd_;
};
