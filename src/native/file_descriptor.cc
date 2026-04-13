#include "file_descriptor.h"

#include <unistd.h>

FileDescriptor::FileDescriptor() : fd_(-1) {}

FileDescriptor::FileDescriptor(int fd) : fd_(fd) {}

FileDescriptor::~FileDescriptor() {
  if (fd_ >= 0) {
    ::close(fd_);
  }
}

FileDescriptor::FileDescriptor(FileDescriptor&& other) noexcept : fd_(other.fd_) {
  other.fd_ = -1;
}

FileDescriptor& FileDescriptor::operator=(FileDescriptor&& other) noexcept {
  if (this != &other) {
    if (fd_ >= 0) {
      ::close(fd_);
    }
    fd_ = other.fd_;
    other.fd_ = -1;
  }
  return *this;
}

int FileDescriptor::get() const {
  return fd_;
}

int FileDescriptor::release() {
  int temp = fd_;
  fd_ = -1;
  return temp;
}

bool FileDescriptor::is_valid() const {
  return fd_ >= 0;
}

void FileDescriptor::reset(int fd) {
  if (fd_ >= 0) {
    ::close(fd_);
  }
  fd_ = fd;
}
